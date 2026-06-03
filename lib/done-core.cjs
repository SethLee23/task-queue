'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED, colIndex,
} = require('./workbook.cjs');
const { STATES } = require('./states.cjs');
const { gitStatus, gitAdd, gitCommit, gitRevParseHead, gitLogToday } = require('./git.cjs');
const { writeHeartbeat, readHeartbeat } = require('./heartbeat.cjs');
const { localTimestamp } = require('./datetime.cjs');

/**
 * 拼一段 `[done ts]` 块，写到 note 顶部供 dashboard 完成区展示。
 * @param {{ts: string, commitHash?: string, version?: string, moduleName?: string, summary?: string}} info
 * @returns {string}
 */
function buildDoneBlock({ ts, commitHash, version, moduleName, summary }) {
  const lines = [`[done ${ts}]`];
  if (commitHash) {
    lines.push(`commit ${commitHash} · 【${moduleName}】 ${version}`);
  } else {
    lines.push('无文件改动');
  }
  if (summary && String(summary).trim()) lines.push(String(summary).trim());
  return lines.join('\n');
}

/**
 * 把新 block 接到 oldNote 顶部，与 reply 的格式对齐。
 * @param {string|undefined} oldNote
 * @param {string} block
 * @returns {string}
 */
function prependDoneBlock(oldNote, block) {
  const old = String(oldNote || '');
  return old ? `${block}\n---\n${old}` : block;
}

/**
 * 默认版本号 bump 策略：patch + 1，保留后缀（如 -beta）。
 * @param {string} current
 * @returns {string}
 */
function bumpPatchDefault(current) {
  const m = String(current).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`无法解析版本号: ${current}`);
  return `${m[1]}.${m[2]}.${parseInt(m[3], 10) + 1}${m[4]}`;
}

/**
 * 把指定行从进行中表移到已完结表（按 column key 匹配写入）。
 * @param {string} xlsxPath
 * @param {object} rowData 含 _rowNumber 的行对象
 */
async function moveRowToArchive(xlsxPath, rowData) {
  await withWorkbook(xlsxPath, async wb => {
    const wsIn = wb.getWorksheet(SHEET_IN_PROGRESS);
    const wsArch = wb.getWorksheet(SHEET_ARCHIVED);
    const { _rowNumber, ...cleanRow } = rowData;
    wsArch.addRow(cleanRow);
    wsIn.spliceRows(_rowNumber, 1);
  });
}

/**
 * 任务收尾 heartbeat:从 currentTaskIds 摘除 taskId,剩余非空 → executing,空 → idle。
 * 串行路径(单任务)等价于旧的 {phase:'idle', currentTaskId:null}。
 */
function releaseTask(projectRoot, taskId, { finishedAt } = {}) {
  const prev = readHeartbeat(projectRoot) || {};
  const remaining = (prev.currentTaskIds || []).filter(x => String(x) !== String(taskId));
  writeHeartbeat(projectRoot, {
    phase: remaining.length ? 'executing' : 'idle',
    currentTaskIds: remaining,
    lastFinishedId: taskId,
    lastFinishedAt: finishedAt || new Date().toISOString(),
  });
}

/**
 * 状态置为"已完成-待review"并写入风险提示，同时打日志。
 *
 * 关键:worker 传入的 summary 代表它的成果/答案(回答型任务里 summary 就是完整答案),
 * 转 review 不能把它丢掉 —— 否则 dashboard 完成/历史区什么都看不到,用户看到的是"空回复"
 * (回归 2026-05-29 ditto 任务 #14)。非空 summary 一律作为 [done] 块写进 note 顶部保全,
 * 与归档路径的落盘形态一致;risk 列单独承载"为什么需要 review"。
 *
 * @param {string} xlsxPath
 * @param {number} rowNumber
 * @param {string} riskMsg
 * @param {Logger} logger
 * @param {string} projectRoot
 * @param {number|string} taskId
 * @param {{summary?: string, oldNote?: string}} [opts] summary 非空时写进 note 的 [done] 块
 */
async function transitionToReview(xlsxPath, rowNumber, riskMsg, logger, projectRoot, taskId, opts = {}) {
  const { summary, oldNote } = opts;
  const keepSummary = summary != null && String(summary).trim() !== '';
  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const r = ws.getRow(rowNumber);
    r.getCell(colIndex('status')).value = STATES.REVIEW;
    r.getCell(colIndex('risk')).value = riskMsg;
    if (keepSummary) {
      const block = `[done ${localTimestamp()}]\n${String(summary).trim()}`;
      r.getCell(colIndex('note')).value = prependDoneBlock(oldNote, block);
    }
    r.commit();
  });
  if (logger) logger.warn(`task → review: ${riskMsg}`);
  releaseTask(projectRoot, taskId);
}

/**
 * commit + 归档核心(原 done.cjs try 块主体)。前提:target 已校验 IN_PROGRESS、scope 存在且 autoCommit、summary 非空。
 * @returns {Promise<{ok:true, commitHash:string|null, version:string|null, moduleName:string|null}|{review:true, risk:string}>}
 */
async function commitAndArchive({ projectRoot, xlsxPath, target, cfg, scopeName, summary, logger }) {
  try {
    // .tasks/ 是 task-queue 自身的工作区(配置/工作簿/锁/日志),不应混入业务 commit。
    // 真实项目不一定会把 .tasks/ 加进 .gitignore(测试 fixture 加了所以测试侧看不到)。
    // 在 stage 前一律过滤,避免归档 commit 误带 .tasks/project.config.js 等。
    const changedFiles = gitStatus(projectRoot).filter(p => !p.startsWith('.tasks/'));
    if (changedFiles.length === 0) {
      target.note = prependDoneBlock(target.note, buildDoneBlock({
        ts: localTimestamp(), summary,
      }));
      target.status = STATES.DONE;
      target.ftime = new Date().toISOString();
      await moveRowToArchive(xlsxPath, target);
      releaseTask(projectRoot, target.id, { finishedAt: target.ftime });
      return { ok: true, commitHash: null, version: null, moduleName: null };
    }

    const moduleName = cfg.inferModule(changedFiles, scopeName);
    if (moduleName == null) {
      await transitionToReview(
        xlsxPath,
        target._rowNumber,
        '模块名推断失败，请补全 commit message 后改回待办',
        logger,
        projectRoot,
        target.id,
        { summary, oldNote: target.note },
      );
      return { review: true, risk: '模块名推断失败' };
    }

    // versionFiles[scope] 必须配置为指向 package.json 一类文件;空串/未配 → 视为缺配置,转 review。
    // 否则 path.join(root, '') === root,下面 readFileSync 会抛 EISDIR(目录不可 read)。
    const versionRel = cfg.versionFiles && cfg.versionFiles[scopeName];
    if (!versionRel || typeof versionRel !== 'string' || !versionRel.trim()) {
      await transitionToReview(
        xlsxPath,
        target._rowNumber,
        `versionFiles[${scopeName}] 未配置或为空,无法 bump 版本号;请在 .tasks/project.config.js 补 versionFiles.${scopeName}`,
        logger,
        projectRoot,
        target.id,
        { summary, oldNote: target.note },
      );
      return { review: true, risk: `versionFiles[${scopeName}] 未配置或为空,无法 bump 版本号;请在 .tasks/project.config.js 补 versionFiles.${scopeName}` };
    }
    const versionFile = path.join(projectRoot, versionRel);
    const pkg = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    const currentVersion = pkg.version;

    let version;
    const todayLog = gitLogToday(projectRoot);
    const escVer = currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versionUsedToday = new RegExp(`(?<![\\w.\\-])${escVer}(?![\\w.\\-])`).test(todayLog);
    if (cfg.sameDayShareVersion && versionUsedToday) {
      version = currentVersion;
    } else {
      version = (cfg.bumpVersion || bumpPatchDefault)(currentVersion);
      pkg.version = version;
      fs.writeFileSync(versionFile, JSON.stringify(pkg, null, 2) + '\n');
    }

    // changelogFiles[scope] 可选;空串/未配 → 跳过 changelog 追加,只 commit 业务变更。
    // 历史 bug:空串触发 path.join(root, '') === root → readFileSync 抛 EISDIR,
    // 整个 commit 流程被吞掉转 review。详见 task #1 2026-05-25。
    const changelogRel = cfg.changelogFiles && cfg.changelogFiles[scopeName];
    if (changelogRel && typeof changelogRel === 'string' && changelogRel.trim()) {
      const changelogFile = path.join(projectRoot, changelogRel);
      if (!fs.existsSync(changelogFile)) {
        fs.writeFileSync(changelogFile, '');
      }
      const changelogContent = fs.readFileSync(changelogFile, 'utf8');
      const entryLine = `【${moduleName}】${target.desc}；`;
      const versionHeader = `## ${version}`;
      let newChangelog;
      if (changelogContent.includes(versionHeader)) {
        // 注意：版本号包含多个 . 需全部转义为 \.
        const escapedHeader = versionHeader.replace(/\./g, '\\.');
        newChangelog = changelogContent.replace(
          new RegExp(`(${escapedHeader}[^\\n]*\\n)`),
          (_, header) => `${header}${entryLine}\n`,
        );
      } else {
        newChangelog = `${versionHeader}\n${entryLine}\n\n${changelogContent}`;
      }
      fs.writeFileSync(changelogFile, newChangelog);
    }

    const allChanged = gitStatus(projectRoot).filter(p => !p.startsWith('.tasks/'));
    gitAdd(projectRoot, allChanged);

    const commitMsg = cfg.commitMessage({
      id: target.id, scope: scopeName, module: moduleName, desc: target.desc, summary, version,
    });
    gitCommit(projectRoot, commitMsg);
    const commitHash = gitRevParseHead(projectRoot);

    target.note = prependDoneBlock(target.note, buildDoneBlock({
      ts: localTimestamp(), commitHash, version, moduleName, summary,
    }));
    target.status = STATES.DONE;
    target.ftime = new Date().toISOString();
    await moveRowToArchive(xlsxPath, target);
    releaseTask(projectRoot, target.id, { finishedAt: target.ftime });
    return { ok: true, commitHash, version, moduleName };
  } catch (e) {
    const msg = (e.message || '').slice(0, 200);
    await transitionToReview(
      xlsxPath,
      target._rowNumber,
      `commit 阶段失败：${msg}`,
      logger,
      projectRoot,
      target.id,
      { summary, oldNote: target.note },
    );
    return { review: true, risk: msg };
  }
}

module.exports = { buildDoneBlock, prependDoneBlock, bumpPatchDefault, moveRowToArchive, transitionToReview, releaseTask, commitAndArchive };
