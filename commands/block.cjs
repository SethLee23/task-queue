// commands/block.cjs
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex,
} = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');

/**
 * 把指定 id 的任务状态改为"阻塞-等答疑"，同时写入疑问内容。
 * 阻塞不算完成，不写 ftime。
 * @param {string} projectRoot 项目根目录
 * @param {string[]} args args[0] = 任务 id，args[1] = 疑问内容
 */
module.exports = async function block(projectRoot, args) {
  const idArg = args[0];
  const question = args[1];
  if (!idArg) throw new Error('block 需要 id 参数');
  if (!question) throw new Error('block 需要 question 参数（疑问内容）');
  if (String(question).startsWith('--')) {
    throw new Error(
      `block 不接受 --flag 参数（收到: ${question}）。正确用法：block <id> "<疑问内容>"`,
    );
  }

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);

  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);

  if (!canTransition(target.status, STATES.BLOCKED)) {
    throw new Error(`非法转换：${target.status} → ${STATES.BLOCKED}`);
  }

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(target._rowNumber);
    row.getCell(colIndex('status')).value = STATES.BLOCKED;
    row.getCell(colIndex('question')).value = question;
    row.commit();
  });

  new Logger(projectRoot).info(`task #${target.id} → blocked: ${question}`);
  writeHeartbeat(projectRoot, {
    phase: 'idle',
    currentTaskId: null,
    lastFinishedId: target.id,
    lastFinishedAt: new Date().toISOString(),
  });
};
