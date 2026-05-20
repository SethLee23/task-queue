'use strict';

const path = require('node:path');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { ARCHIVED_SHEET_STATES } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * 将进行中 sheet 里状态为"已完成/跳过"的行剪切到已完结 sheet。
 * 从后往前删行，避免 spliceRows 导致行号偏移。
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} _args 未使用
 * @returns {Promise<void>}
 */
module.exports = async function sweep(projectRoot, _args) {
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const toArchive = rows.filter(r => ARCHIVED_SHEET_STATES.includes(r.status));

  if (toArchive.length === 0) {
    process.stdout.write(JSON.stringify({ archived: 0 }) + '\n');
    return;
  }

  // 从后往前删，避免行号偏移
  const sortedDesc = [...toArchive].sort((a, b) => b._rowNumber - a._rowNumber);

  await withWorkbook(xlsxPath, async wb => {
    const wsIn = wb.getWorksheet(SHEET_IN_PROGRESS);
    const wsArch = wb.getWorksheet(SHEET_ARCHIVED);
    for (const r of sortedDesc) {
      // 剥离内部字段 _rowNumber，避免写入 Excel 列
      const { _rowNumber, ...cleanRow } = r;
      wsArch.addRow(cleanRow);
      wsIn.spliceRows(_rowNumber, 1);
    }
  });

  new Logger(projectRoot).info(`swept ${toArchive.length} rows to 已完结`);
  process.stdout.write(JSON.stringify({ archived: toArchive.length }) + '\n');
};
