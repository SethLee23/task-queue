// commands/review.cjs
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex,
} = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * 把指定 id 的任务状态改为"已完成-待review"，同时写入风险描述和完成时间。
 * @param {string} projectRoot 项目根目录
 * @param {string[]} args args[0] = 任务 id，args[1] = 风险描述
 */
module.exports = async function review(projectRoot, args) {
  const idArg = args[0];
  const risk = args[1];
  if (!idArg) throw new Error('review 需要 id 参数');
  if (!risk) throw new Error('review 需要 risk 参数（风险描述）');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);

  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);

  if (!canTransition(target.status, STATES.REVIEW)) {
    throw new Error(`非法转换：${target.status} → ${STATES.REVIEW}`);
  }

  const ftime = new Date().toISOString();

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(target._rowNumber);
    row.getCell(colIndex('status')).value = STATES.REVIEW;
    row.getCell(colIndex('risk')).value = risk;
    row.getCell(colIndex('ftime')).value = ftime;
    row.commit();
  });

  new Logger(projectRoot).info(`task #${target.id} → review: ${risk}`);
};
