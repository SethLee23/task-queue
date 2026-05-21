'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS,
} = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbook-lock-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('withWorkbook 并发写串行化 — 两次 addRow 都到位', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);

  await Promise.all([
    withWorkbook(xlsx, async wb => {
      wb.getWorksheet(SHEET_IN_PROGRESS).addRow({ id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办' });
    }),
    withWorkbook(xlsx, async wb => {
      wb.getWorksheet(SHEET_IN_PROGRESS).addRow({ id: 2, desc: 'b', scope: 'web', priority: '中', status: '待办' });
    }),
  ]);

  const rows = await readRows(xlsx, SHEET_IN_PROGRESS);
  assert.equal(rows.length, 2);
  const ids = rows.map(r => String(r.id)).sort();
  assert.deepEqual(ids, ['1', '2'], '两行都应入表，无丢失');
});

test('withWorkbook 自动创建 run/ 子目录用于放锁', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);

  await withWorkbook(xlsx, async wb => {
    wb.getWorksheet(SHEET_IN_PROGRESS).addRow({ id: 1, desc: 'x', scope: 'web', priority: '中', status: '待办' });
  });

  assert.equal(fs.existsSync(path.join(proj, '.tasks', 'run')), true);
  assert.equal(fs.existsSync(path.join(proj, '.tasks', 'run', '.xlsx.lock')), false, '锁应已释放');
});
