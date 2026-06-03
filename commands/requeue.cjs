'use strict';

const path = require('node:path');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex } = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { writeHeartbeat, readHeartbeat } = require('../lib/heartbeat.cjs');
const { localTimestamp } = require('../lib/datetime.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * needs-code 回流:non-code worker 发现任务其实要改代码时,主 loop 调本命令把任务
 * IN_PROGRESS → TODO,note 顶部加 [needs-code] 标记;下一轮 plan-batch 看到标记强制走 code lane。
 * @param {string} projectRoot
 * @param {string[]} args args[0]=id, args[1]=原因
 */
module.exports = async function requeue(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('requeue 需要 id 参数');
  const reason = args[1] || '';
  if (reason.startsWith('--')) throw new Error('reason 不能以 -- 开头(疑似误传 flag)');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);
  if (!canTransition(target.status, STATES.TODO)) {
    throw new Error(`非法转换:#${idArg} ${target.status} → 待办`);
  }

  const tag = `[needs-code ${localTimestamp()}] ${reason}`.trim();
  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(target._rowNumber);
    row.getCell(colIndex('status')).value = STATES.TODO;
    const prevNote = target.note || '';
    row.getCell(colIndex('note')).value = prevNote ? `${tag}\n---\n${prevNote}` : tag;
    row.commit();
  });

  const prev = readHeartbeat(projectRoot) || {};
  const remaining = (prev.currentTaskIds || []).filter(x => String(x) !== String(idArg));
  writeHeartbeat(projectRoot, {
    phase: remaining.length ? 'executing' : 'idle',
    currentTaskIds: remaining,
  });

  new Logger(projectRoot).warn(`task #${idArg} requeue(needs-code): ${reason}`);
  process.stdout.write(JSON.stringify({ ok: true, taskId: idArg }) + '\n');
};
