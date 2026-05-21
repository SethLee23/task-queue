// tests/commands.reply.test.cjs
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const replyCmd = require('../commands/reply.cjs');
const { replyCore } = require('../commands/reply.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-reply-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function setupProject(rows) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
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

const baseRow = {
  id: 1, desc: '抽 skill', scope: 'web', priority: '高',
  note: '原备注', question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
};

test('reply 不带 resume：仅在 note 顶部追加 [reply ...] 块，状态不变', async () => {
  const proj = await setupProject([{ ...baseRow, status: '阻塞-等答疑', question: '问题1?' }]);
  await replyCore(proj, { id: 1, reply: '答复内容' });

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const row = rows.find(r => String(r.id) === '1');
  assert.equal(row.status, '阻塞-等答疑');
  assert.equal(row.question, '问题1?', 'question 未被清空');
  assert.ok(/^\[reply \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 答复内容\n---\n原备注$/.test(row.note),
    `note 格式应为时间戳 + 答复 + 分隔符 + 原 note，实际: ${row.note}`);
});

test('reply 带 resume：blocked → todo 且 question 内容迁移进 note', async () => {
  const proj = await setupProject([{ ...baseRow, status: '阻塞-等答疑', question: '问题1?' }]);
  await replyCore(proj, { id: 1, reply: '解阻答复', resume: true });

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const row = rows.find(r => String(r.id) === '1');
  assert.equal(row.status, '待办');
  assert.equal(row.question, '', 'question 字段应被清空');
  assert.ok(/^\[reply \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\nQ: 问题1\?\nA: 解阻答复/.test(row.note),
    `note 应含 Q/A 格式，实际: ${row.note}`);
});

test('reply 带 resume：review → todo 且 risk 内容迁移进 note', async () => {
  const proj = await setupProject([{ ...baseRow, status: '已完成-待review', risk: '改了热路径' }]);
  await replyCore(proj, { id: 1, reply: 'reject 这条', resume: true });

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const row = rows.find(r => String(r.id) === '1');
  assert.equal(row.status, '待办');
  assert.equal(row.risk, '', 'risk 字段应被清空');
  assert.ok(/^\[reply \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\nRisk: 改了热路径\nA: reject 这条/.test(row.note),
    `note 应含 Risk/A 格式，实际: ${row.note}`);
});

test('reply 带 resume 在非 blocked/review 状态拒绝', async () => {
  const proj = await setupProject([{ ...baseRow, status: '待办' }]);
  await assert.rejects(
    () => replyCore(proj, { id: 1, reply: 'x', resume: true }),
    /仅适用于 阻塞\/待review/,
  );
});

test('reply 内容空字符串拒绝', async () => {
  const proj = await setupProject([{ ...baseRow, status: '阻塞-等答疑' }]);
  await assert.rejects(() => replyCore(proj, { id: 1, reply: '   ' }), /不能为空/);
});

test('reply 未找到 id 抛错', async () => {
  const proj = await setupProject([{ ...baseRow, status: '阻塞-等答疑' }]);
  await assert.rejects(() => replyCore(proj, { id: 999, reply: 'x' }), /未找到/);
});

test('reply CLI 入口接受 args=[id,reply,"true"] 并把结果以 JSON 写到 stdout', async () => {
  const proj = await setupProject([{ ...baseRow, status: '阻塞-等答疑', question: 'q?' }]);
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = chunk => { captured += chunk; return true; };
  try {
    await replyCmd(proj, ['1', 'CLI 答复', 'true']);
  } finally {
    process.stdout.write = origWrite;
  }
  const result = JSON.parse(captured.trim());
  assert.equal(result.resumed, true);
  assert.equal(result.status, '待办');
});
