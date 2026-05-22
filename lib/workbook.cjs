const ExcelJS = require('exceljs');
const fs = require('node:fs');
const path = require('node:path');
const { withLock } = require('./lock.cjs');

const SHEET_IN_PROGRESS = '进行中';
const SHEET_ARCHIVED = '已完结';

const COLUMNS = [
  { header: 'ID',         key: 'id',       width: 6  },
  { header: '任务描述',   key: 'desc',     width: 60 },
  { header: '范围',       key: 'scope',    width: 8  },
  { header: '优先级',     key: 'priority', width: 8  },
  { header: '状态',       key: 'status',   width: 16 },
  { header: '备注',       key: 'note',     width: 30 },
  { header: '待解疑问',   key: 'question', width: 30 },
  { header: '风险提示',   key: 'risk',     width: 30 },
  { header: '创建时间',   key: 'ctime',    width: 20 },
  { header: '完成时间',   key: 'ftime',    width: 20 },
  { header: '模型',       key: 'model',    width: 10 },
  { header: '标签',       key: 'tags',     width: 20 },
];

async function createBlankWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'task-queue';
  wb.created = new Date();

  const ws1 = wb.addWorksheet(SHEET_IN_PROGRESS);
  ws1.columns = COLUMNS;
  ws1.getRow(1).font = { bold: true };

  const ws2 = wb.addWorksheet(SHEET_ARCHIVED);
  ws2.columns = COLUMNS;
  ws2.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(filePath);
}

async function readRows(filePath, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // 表头
    const obj = { _rowNumber: rowNumber };
    COLUMNS.forEach((col, idx) => {
      const cell = row.getCell(idx + 1);
      // 保留原始类型（数字保持数字），仅在 null/undefined 时转为空字符串
      obj[col.key] = cell.value == null ? '' : cell.value;
    });
    rows.push(obj);
  });
  return rows;
}

/**
 * 读取 xlsx 后重新绑定列 key，因为 exceljs 从文件读取时 column key 会丢失，
 * 导致 addRow({ key: value }) 无法按 key 匹配写入列。
 * @param {import('exceljs').Worksheet} ws
 */
function _rebindColumnKeys(ws) {
  const headerRow = ws.getRow(1);
  COLUMNS.forEach((col, idx) => {
    ws.getColumn(idx + 1).key = col.key;
    const headerCell = headerRow.getCell(idx + 1);
    if (headerCell.value == null || headerCell.value === '') {
      headerCell.value = col.header;
    }
  });
}

async function withWorkbook(filePath, mutator) {
  const lockDir = path.join(path.dirname(filePath), 'run', '.xlsx.lock');
  return withLock(lockDir, async () => {
    const bakPath = filePath + '.bak';
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    // exceljs 读取后 column key 丢失，需要重新绑定才能让 addRow 按 key 写入
    _rebindColumnKeys(wb.getWorksheet(SHEET_IN_PROGRESS));
    _rebindColumnKeys(wb.getWorksheet(SHEET_ARCHIVED));

    try {
      await mutator(wb);
      await wb.xlsx.writeFile(filePath);
      // sanity check：能重新读出来
      const verifyWb = new ExcelJS.Workbook();
      await verifyWb.xlsx.readFile(filePath);
      if (!verifyWb.getWorksheet(SHEET_IN_PROGRESS) || !verifyWb.getWorksheet(SHEET_ARCHIVED)) {
        throw new Error('sanity check 失败：写入后 sheet 丢失');
      }
    } catch (e) {
      if (fs.existsSync(bakPath)) {
        fs.copyFileSync(bakPath, filePath);
      }
      throw e;
    }
  });
}

/**
 * 返回 COLUMNS 中指定 key 的 1-based 列号。
 * @param {string} key
 * @returns {number}
 */
function colIndex(key) {
  return COLUMNS.findIndex(c => c.key === key) + 1;
}

module.exports = {
  COLUMNS,
  SHEET_IN_PROGRESS,
  SHEET_ARCHIVED,
  createBlankWorkbook,
  readRows,
  withWorkbook,
  colIndex,
};
