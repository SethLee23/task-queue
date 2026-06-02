// commands/mark-done.cjs — 把 待review / 阻塞 状态的任务手动标记为已完成并归档。
//
// 与 done.cjs 的区别:done 走「进行中 → 已完成 + auto commit + version bump + changelog」
// 的完整流程,只接受 IN_PROGRESS。mark-done 只做状态迁移 + 归档,不碰 git/版本/changelog,
// 用于用户在面板上确认 review/blocked 任务"实际上已经搞定了",直接进归档。
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED, colIndex,
} = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
const { localTimestamp } = require('../lib/datetime.cjs');
const { prependDoneBlock } = require('./done.cjs');

/**
 * 拼装手动标记完成的 [done ts] 块,留下来源状态(review/blocked)和原 risk/question 作上下文,
 * 让 dashboard 完成区可以看出这是「手动确认」而不是 done 命令归档。
 * @param {{ts: string, fromStatus: string, risk?: string, question?: string, summary: string}} info
 * @returns {string}
 */
function buildManualDoneBlock({ ts, fromStatus, risk, question, summary }) {
  const fromLabel = fromStatus === STATES.REVIEW ? '待 review' : '阻塞';
  const lines = [`[done ${ts}]`, `手动标记完成（来自${fromLabel}）`];
  const trimRisk = String(risk || '').trim();
  const trimQ = String(question || '').trim();
  if (fromStatus === STATES.REVIEW && trimRisk) lines.push(`原 Risk: ${trimRisk}`);
  if (fromStatus === STATES.BLOCKED && trimQ) lines.push(`原 Q: ${trimQ}`);
  lines.push(`说明: ${String(summary).trim()}`);
  return lines.join('\n');
}

/**
 * 核心实现,供 CLI 与 dashboard server 共用。
 *
 * 行为:
 * - 目标状态必须 ∈ {REVIEW, BLOCKED};其他状态拒绝(IN_PROGRESS 走 done,TODO 走 claim+done)
 * - summary 必填,空 → 抛错(避免 dashboard 上"已完成区什么都看不到")
 * - 在 note 顶部追加 [done ts] 块(`手动标记完成` + 原 risk/question + 说明)
 * - status 置 DONE,ftime = now,从进行中表移到已完结表
 * - 更新 heartbeat lastFinishedId/lastFinishedAt(面板能感知到刚完成的任务)
 *
 * @param {string} projectRoot 项目根目录
 * @param {{ id: number|string, summary: string }} fields
 * @returns {Promise<{ id: number|string, status: string, fromStatus: string, ftime: string }>}
 */
async function markDoneCore(projectRoot, fields) {
  const { id } = fields;
  if (id == null || id === '') throw new Error('mark-done 需要 id 参数');
  const summary = String(fields.summary || '').trim();
  if (!summary) throw new Error('mark-done 需要 summary 参数（说明手动标记完成的原因）');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(id));
  if (!target) throw new Error(`未找到 id=${id} 的任务`);

  if (target.status !== STATES.REVIEW && target.status !== STATES.BLOCKED) {
    throw new Error(`mark-done 仅适用于 待review/阻塞 状态，当前: ${target.status}`);
  }
  if (!canTransition(target.status, STATES.DONE)) {
    throw new Error(`非法转换：${target.status} → ${STATES.DONE}`);
  }

  const ts = localTimestamp();
  const block = buildManualDoneBlock({
    ts,
    fromStatus: target.status,
    risk: target.risk,
    question: target.question,
    summary,
  });
  const newNote = prependDoneBlock(target.note, block);
  const ftime = new Date().toISOString();
  const fromStatus = target.status;

  await withWorkbook(xlsxPath, async wb => {
    const wsIn = wb.getWorksheet(SHEET_IN_PROGRESS);
    const wsArch = wb.getWorksheet(SHEET_ARCHIVED);
    const { _rowNumber, ...cleanRow } = target;
    cleanRow.status = STATES.DONE;
    cleanRow.note = newNote;
    cleanRow.ftime = ftime;
    wsArch.addRow(cleanRow);
    wsIn.spliceRows(_rowNumber, 1);
  });

  new Logger(projectRoot).info(
    `task #${target.id} mark-done (from ${fromStatus}): ${summary.slice(0, 60)}`,
  );
  writeHeartbeat(projectRoot, {
    phase: 'idle',
    currentTaskId: null,
    lastFinishedId: target.id,
    lastFinishedAt: ftime,
  });

  return { id: target.id, status: STATES.DONE, fromStatus, ftime };
}

/**
 * CLI 入口: args = [id, summary]
 *
 * @param {string} projectRoot
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function markDoneCli(projectRoot, args) {
  const [idArg, summaryArg] = args;
  if (summaryArg != null && String(summaryArg).startsWith('--')) {
    throw new Error(
      `mark-done 不接受 --flag 参数（收到: ${summaryArg}）。正确用法：mark-done <id> "<说明>"`,
    );
  }
  const result = await markDoneCore(projectRoot, { id: idArg, summary: summaryArg });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = markDoneCli;
module.exports.markDoneCore = markDoneCore;
module.exports.buildManualDoneBlock = buildManualDoneBlock;
