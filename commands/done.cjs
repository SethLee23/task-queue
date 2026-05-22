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
 * 更新进行中表指定行的 status / risk / ftime 字段。
 * @param {string} xlsxPath
 * @param {number} rowNumber 1-based 行号
 * @param {string} status
 * @param {string|null} risk 为 null 时不写
 * @param {string|null} ftime 为 null 时不写
 */
async function setStatusAndRisk(xlsxPath, rowNumber, status, risk, ftime) {
  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const r = ws.getRow(rowNumber);
    r.getCell(colIndex('status')).value = status;
    if (risk != null) r.getCell(colIndex('risk')).value = risk;
    if (ftime != null) r.getCell(colIndex('ftime')).value = ftime;
    r.commit();
  });
}

/**
 * 状态置为"已完成-待review"并写入风险提示，同时打日志。
 * @param {string} xlsxPath
 * @param {number} rowNumber
 * @param {string} riskMsg
 * @param {Logger} logger
 * @param {string} projectRoot
 * @param {number|string} taskId
 */
async function transitionToReview(xlsxPath, rowNumber, riskMsg, logger, projectRoot, taskId) {
  await setStatusAndRisk(xlsxPath, rowNumber, STATES.REVIEW, riskMsg, null);
  if (logger) logger.warn(`task → review: ${riskMsg}`);
  writeHeartbeat(projectRoot, {
    phase: 'idle',
    currentTaskId: null,
    lastFinishedId: taskId,
    lastFinishedAt: new Date().toISOString(),
  });
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
    await transitionToReview(xlsxPath, target._rowNumber, `未识别的 scope: ${scopeName}`, logger, projectRoot, target.id);
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
    );
    return;
  }

  try {
    const changedFiles = gitStatus(projectRoot);
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
      );
      return;
    }

    const versionFile = path.join(projectRoot, cfg.versionFiles[scopeName]);
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

    const changelogFile = path.join(projectRoot, cfg.changelogFiles[scopeName]);
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

    const allChanged = gitStatus(projectRoot);
    gitAdd(projectRoot, allChanged);

    const commitMsg = cfg.commitMessage({
      scope: scopeName, module: moduleName, desc: target.desc, version,
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
    );
  }
};

module.exports.buildDoneBlock = buildDoneBlock;
module.exports.prependDoneBlock = prependDoneBlock;
