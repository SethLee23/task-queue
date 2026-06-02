'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  readRows, withWorkbook, COLUMNS, SHEET_IN_PROGRESS, SHEET_ARCHIVED, colIndex,
} = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { Logger } = require('../lib/logger.cjs');
const { gitStatus, gitAdd, gitCommit, gitRevParseHead, gitLogToday } = require('../lib/git.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
const { localTimestamp } = require('../lib/datetime.cjs');
const { parseChecklist, summarize } = require('../lib/checklist.cjs');

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
  writeHeartbeat(projectRoot, {
    phase: 'idle',
    currentTaskId: null,
    lastFinishedId: taskId,
    lastFinishedAt: new Date().toISOString(),
  });
}

/**
 * checklist 未做完时,worker 误调 done 的兜底:状态回退到 TODO,note 顶部追加被拒说明 + worker
 * 给出的 summary,heartbeat 置 idle 但不写 lastFinishedId(任务并未结束)。下一轮 loop 会重新
 * dispatch,worker 看到 checklist 已勾项 + note 里的"上轮被拒"提示后从首个未勾项续做。
 * @param {string} xlsxPath
 * @param {object} target 含 _rowNumber/note 的行对象
 * @param {string} summary worker 误传的完成总结(保留给用户参考)
 * @param {{done:number, total:number, nextUndone:string|null}} s 摘要
 * @param {Logger} logger
 * @param {string} projectRoot
 */
async function revertToTodoForIncompleteChecklist(xlsxPath, target, summary, s, logger, projectRoot) {
  const ts = localTimestamp();
  const nextHint = s.nextUndone ? `,下一项: ${s.nextUndone}` : '';
  const summaryLine = summary && String(summary).trim()
    ? `\nworker summary: ${String(summary).trim()}`
    : '';
  const tag = `[done 被拒 ${ts}] checklist 仅 ${s.done}/${s.total} 完成${nextHint}。任务已回退到待办,下一轮 loop 将续做剩余项。${summaryLine}`;
  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const r = ws.getRow(target._rowNumber);
    r.getCell(colIndex('status')).value = STATES.TODO;
    const prevNote = target.note || '';
    r.getCell(colIndex('note')).value = prevNote ? `${tag}\n---\n${prevNote}` : tag;
    r.commit();
  });
  if (logger) logger.warn(`task #${target.id} done 被拒(checklist ${s.done}/${s.total}),回退到 TODO`);
  writeHeartbeat(projectRoot, { phase: 'idle', currentTaskId: null });
}

/**
 * 标记任务为已完成 + 触发 auto commit（如 scope 允许）。
 *
 * 流程：
 * 1. 校验目标行状态必须为"进行中"
 * 2. scope.autoCommit=false → 转 review
 * 3. 工作区无改动 → 直接归档
 * 4. inferModule 返回 null → 转 review
 * 5. 决定版本号（sameDayShareVersion 命中则复用，否则 bump）
 * 6. 追加 changelog 条目，gitAdd + gitCommit
 * 7. 状态置已完成 + 归档；任何 commit 阶段异常都回退到 review
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} args args[0] = task id
 * @returns {Promise<void>}
 */
module.exports = async function done(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('done 需要 id 参数');
  const summary = args[1];

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const cfg = loadProjectConfig(projectRoot);
  const logger = new Logger(projectRoot);

  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);
  if (target.status !== STATES.IN_PROGRESS) {
    throw new Error(`非法转换：${target.status} → 已完成（必须先 claim 进入进行中）`);
  }

  // checklist 防御:worker 在子项未做完时调 done 是常见误判(prompt 写明也照犯,尤其 Sonnet/Haiku)。
  // 任一项未勾 → 回退到 TODO 让 loop 自动续做,避免用户看到 6/8 进度的任务被错误归档。
  // 空 checklist / 全勾 → 跳过,走正常流程。
  const checklistItems = parseChecklist(target.checklist);
  if (checklistItems.length > 0) {
    const s = summarize(checklistItems);
    if (s.done < s.total) {
      await revertToTodoForIncompleteChecklist(xlsxPath, target, summary, s, logger, projectRoot);
      return;
    }
  }

  // summary 强制要求:空 summary 转 review,避免 dashboard 上"完成区什么都看不到"的体验事故。
  // 触发条件:loop 没读最新 loop-prompt 或人工调 done 时漏传。把 risk 写明白让人/AI 都能 reply 补上。
  if (!summary || !String(summary).trim()) {
    await transitionToReview(
      xlsxPath,
      target._rowNumber,
      'Claude 未提供 summary。loop-prompt.md Step 4a 要求 done 必传 summary —— '
      + '执行型任务写 1-2 句改动/决策,回答型任务直接写完整答案。'
      + '请 reply 补一段答复并 resume,下一轮 loop 重新 done(把答复内容用作 summary)。',
      logger,
      projectRoot,
      target.id,
    );
    return;
  }

  const scopeName = target.scope;
  const scopeCfg = cfg.scopes[scopeName];
  if (!scopeCfg) {
    await transitionToReview(xlsxPath, target._rowNumber, `未识别的 scope: ${scopeName}`, logger, projectRoot, target.id, { summary, oldNote: target.note });
    return;
  }

  if (!scopeCfg.autoCommit) {
    await transitionToReview(
      xlsxPath,
      target._rowNumber,
      `scope ${scopeName} 不允许自动 commit，请人工 review`,
      logger,
      projectRoot,
      target.id,
      { summary, oldNote: target.note },
    );
    return;
  }

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
      writeHeartbeat(projectRoot, {
        phase: 'idle',
        currentTaskId: null,
        lastFinishedId: target.id,
        lastFinishedAt: target.ftime,
      });
      logger.info(`task #${target.id} done (无文件改动，已归档)`);
      return;
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
      return;
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
      return;
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
    writeHeartbeat(projectRoot, {
      phase: 'idle',
      currentTaskId: null,
      lastFinishedId: target.id,
      lastFinishedAt: target.ftime,
    });
    logger.info(`task #${target.id} done + commit ${commitHash} 【${moduleName}】 ${version}`);
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
  }
};

module.exports.buildDoneBlock = buildDoneBlock;
module.exports.prependDoneBlock = prependDoneBlock;
