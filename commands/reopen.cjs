// commands/reopen.cjs — 已归档(完成/跳过)任务追加回复并重开为 TODO，带回完整 note 历史。
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED,
} = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');
const { localTimestamp } = require('../lib/datetime.cjs');
const { demoteLatestTags, getReplierName } = require('./reply.cjs');

/**
 * 在归档表找 id（状态须 ∈ {DONE, SKIPPED}）→ 回复以 `[<名字> 回复 LATEST ts] ...` 写到 note 顶部
 * （旧 LATEST 降级 OBSOLETE，原 done 块保留在 --- 之下）→ 行从归档搬到进行中表，status=TODO，ftime 清空，
 * id/ctime/scope/priority/desc/tags 等不变。有意的「重开」，不走 canTransition（终态无出边）。
 * @param {string} projectRoot
 * @param {{ id: number|string, reply: string }} fields
 * @returns {Promise<{ id: number|string, status: string, fromStatus: string, reopened: boolean }>}
 */
async function reopenCore(projectRoot, fields) {
  const { id } = fields;
  if (id == null || id === '') throw new Error('reopen 需要 id 参数');
  const replyText = String(fields.reply || '').trim();
  if (!replyText) throw new Error('回复内容不能为空');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const archived = await readRows(xlsxPath, SHEET_ARCHIVED);
  const target = archived.find(r => String(r.id) === String(id));
  if (!target) throw new Error(`未找到 id=${id} 的已归档任务`);

  if (target.status !== STATES.DONE && target.status !== STATES.SKIPPED) {
    throw new Error(`reopen 仅适用于 已完成/跳过 状态，当前: ${target.status}`);
  }

  const oldNote = demoteLatestTags(String(target.note || ''));
  const ts = localTimestamp();
  const block = `[${getReplierName()} 回复 LATEST ${ts}] ${replyText}`;
  const newNote = oldNote ? `${block}\n---\n${oldNote}` : block;
  const fromStatus = target.status;

  await withWorkbook(xlsxPath, async wb => {
    const wsArch = wb.getWorksheet(SHEET_ARCHIVED);
    const wsIn = wb.getWorksheet(SHEET_IN_PROGRESS);
    const { _rowNumber, ...cleanRow } = target;
    cleanRow.status = STATES.TODO;
    cleanRow.note = newNote;
    cleanRow.ftime = '';
    // 清空 review/blocked 遗留的疑问/风险，重开后是干净的 TODO
    cleanRow.question = '';
    cleanRow.risk = '';
    wsIn.addRow(cleanRow);
    wsArch.spliceRows(_rowNumber, 1);
  });

  new Logger(projectRoot).info(
    `task #${target.id} reopen (from ${fromStatus}): ${replyText.slice(0, 60)}`,
  );

  return { id: target.id, status: STATES.TODO, fromStatus, reopened: true };
}

async function reopenCli(projectRoot, args) {
  const [idArg, replyArg] = args;
  if (replyArg != null && String(replyArg).startsWith('--')) {
    throw new Error(
      `reopen 不接受 --flag 参数（收到: ${replyArg}）。正确用法：reopen <id> "<回复>"`,
    );
  }
  const result = await reopenCore(projectRoot, { id: idArg, reply: replyArg });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = reopenCli;
module.exports.reopenCore = reopenCore;
