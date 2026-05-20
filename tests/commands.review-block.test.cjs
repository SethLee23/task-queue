// tests/commands.review-block.test.cjs
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const reviewCmd = require('../commands/review.cjs');
const blockCmd = require('../commands/block.cjs');

// 在测试模块内直接 inline setupProject，不依赖 git
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-review-block-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function setupProject(rows) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  // Logger 需要 .tasks 目录（已创建）
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  if (rows.length > 0) {
    await withWorkbook(xlsx, async wb => {
      const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
      rows.forEach(r => ws.addRow(r));
    });
  }
  return proj;
}

test('review 写状态为"已完成-待review"并写入风险描述', async () => {
  const proj = await setupProject([
    {
      id: 1, desc: '实现登录', scope: 'web', priority: '高',
      status: '进行中', note: '', question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
    },
  ]);

  await reviewCmd(proj, ['1', '兼容 IE11 需二次验证']);

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const row = rows.find(r => String(r.id) === '1');
  assert.ok(row, '行应存在');
  assert.equal(row.status, '已完成-待review');
  assert.equal(row.risk, '兼容 IE11 需二次验证');
  assert.ok(row.ftime, 'ftime 应被写入');
});

test('block 写状态为"阻塞-等答疑"并写入疑问，不写 ftime', async () => {
  const proj = await setupProject([
    {
      id: 2, desc: '重构路由', scope: 'core', priority: '中',
      status: '进行中', note: '', question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
    },
  ]);

  await blockCmd(proj, ['2', '新接口文档在哪里？']);

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const row = rows.find(r => String(r.id) === '2');
  assert.ok(row, '行应存在');
  assert.equal(row.status, '阻塞-等答疑');
  assert.equal(row.question, '新接口文档在哪里？');
  // 阻塞不算完成，ftime 不应被写入（保持原始空值）
  assert.ok(!row.ftime, 'ftime 不应被写入');
});
