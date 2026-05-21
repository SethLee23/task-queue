const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  COLUMNS,
  SHEET_IN_PROGRESS,
  SHEET_ARCHIVED,
  createBlankWorkbook,
  readRows,
  withWorkbook,
} = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-test-'));
const xlsxPath = path.join(tmpDir, 'tasks.xlsx');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => { if (fs.existsSync(xlsxPath)) fs.unlinkSync(xlsxPath); });

test('createBlankWorkbook 创建带两个 sheet、表头与 COLUMNS 对齐的空工作簿', async () => {
  await createBlankWorkbook(xlsxPath);
  assert.ok(fs.existsSync(xlsxPath));
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  assert.equal(wb.worksheets.length, 2);
  const ws1 = wb.getWorksheet(SHEET_IN_PROGRESS);
  const ws2 = wb.getWorksheet(SHEET_ARCHIVED);
  assert.ok(ws1, '进行中 sheet 存在');
  assert.ok(ws2, '已完结 sheet 存在');
  // 表头
  const headers = ws1.getRow(1).values.slice(1); // 第 0 元素是 undefined
  assert.deepEqual(headers, COLUMNS.map(c => c.header));
});

test('COLUMNS 11 列、key 为 id/desc/scope/priority/status/note/question/risk/ctime/ftime/link', () => {
  assert.equal(COLUMNS.length, 11);
  assert.deepEqual(COLUMNS.map(c => c.key), [
    'id', 'desc', 'scope', 'priority', 'status', 'note', 'question', 'risk', 'ctime', 'ftime', 'link',
  ]);
});

test('readRows 读空 sheet 返回空数组', async () => {
  await createBlankWorkbook(xlsxPath);
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  assert.deepEqual(rows, []);
});

test('withWorkbook 在回调里修改后保存', async () => {
  await createBlankWorkbook(xlsxPath);
  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    ws.addRow({
      id: 1, desc: '测试', scope: 'web', priority: '高', status: '待办',
      note: '', question: '', risk: '', ctime: '2026-05-20T14:00:00Z', ftime: ''
    });
  });
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].desc, '测试');
  assert.equal(rows[0].priority, '高');
});

test('withWorkbook 失败时回滚（不持久化）', async () => {
  await createBlankWorkbook(xlsxPath);
  // 先写一行
  await withWorkbook(xlsxPath, async wb => {
    wb.getWorksheet(SHEET_IN_PROGRESS).addRow({
      id: 1, desc: 'original', scope: 'web', priority: '中', status: '待办',
      note: '', question: '', risk: '', ctime: '', ftime: ''
    });
  });
  // 再尝试改但抛错
  await assert.rejects(async () => {
    await withWorkbook(xlsxPath, async wb => {
      wb.getWorksheet(SHEET_IN_PROGRESS).getRow(2).getCell('desc').value = 'changed';
      throw new Error('模拟失败');
    });
  });
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  assert.equal(rows[0].desc, 'original'); // 回滚成功
});

test('withWorkbook 写入前会生成 .bak 备份', async () => {
  await createBlankWorkbook(xlsxPath);
  await withWorkbook(xlsxPath, async wb => {
    wb.getWorksheet(SHEET_IN_PROGRESS).addRow({
      id: 1, desc: 'x', scope: 'web', priority: '高', status: '待办',
      note: '', question: '', risk: '', ctime: '', ftime: ''
    });
  });
  assert.ok(fs.existsSync(xlsxPath + '.bak'), '生成了 .bak');
});
