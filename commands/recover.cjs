'use strict';

const path = require('node:path');
const { readRows, withWorkbook, colIndex, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * 将进行中 sheet 里所有"进行中"状态的行重置为"待办"，
 * 并在 note 字段追加中断标记，用于系统重启/crash 后的任务恢复。
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} _args 未使用
 * @returns {Promise<void>}
 */
module.exports = async function recover(projectRoot, _args) {
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const stuck = rows.filter(r => r.status === STATES.IN_PROGRESS);

  if (stuck.length === 0) {
    process.stdout.write(JSON.stringify({ recovered: 0 }) + '\n');
    return;
  }

  // 精确时间戳用于追责（UTC ISO 比本地日期更有价值）
  const stamp = new Date().toISOString();

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    for (const r of stuck) {
      const row = ws.getRow(r._rowNumber);
      row.getCell(colIndex('status')).value = STATES.TODO;
      const prevNote = r.note || '';
      const tag = `[上次中断已重排队 ${stamp}]`;
      row.getCell(colIndex('note')).value = prevNote ? `${prevNote}\n${tag}` : tag;
      row.commit();
    }
  });

  new Logger(projectRoot).warn(`recovered ${stuck.length} stuck task(s)`);
  process.stdout.write(JSON.stringify({ recovered: stuck.length }) + '\n');
};
