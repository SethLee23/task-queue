'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reply-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const {
  createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS,
} = require('../lib/workbook.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

async function mkProject(rows = []) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'), { recursive: true });
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
  note: '原备注', question: '', risk: '', ctime: '2026-05-21T10:00:00Z', ftime: '',
};

test('POST /reply 普通答复：仅追加 note，状态不变', async () => {
  const proj = await mkProject([{ ...baseRow, status: '阻塞-等答疑', question: 'q?' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, reply: '答复 A' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.task.resumed, false);
  assert.equal(body.task.status, '阻塞-等答疑');

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.ok(rows[0].note.startsWith('[reply '));
  assert.equal(rows[0].question, 'q?');
});

test('POST /reply 带 resume：blocked → todo 且清空 question', async () => {
  const proj = await mkProject([{ ...baseRow, status: '阻塞-等答疑', question: 'q?' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, reply: '解阻', resume: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.task.resumed, true);
  assert.equal(body.task.status, '待办');

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '待办');
  assert.equal(rows[0].question, '');
});

test('POST /reply id 缺失 → 400', async () => {
  const proj = await mkProject([{ ...baseRow, status: '阻塞-等答疑' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reply: 'x' }),
  });
  assert.equal(res.status, 400);
});

test('POST /reply 内容为空 → 400', async () => {
  const proj = await mkProject([{ ...baseRow, status: '阻塞-等答疑' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, reply: '   ' }),
  });
  assert.equal(res.status, 400);
});

test('POST /reply 项目不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/no-such/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, reply: 'x' }),
  });
  assert.equal(res.status, 404);
});

test('POST /reply resume 在非 blocked/review 状态 → 400', async () => {
  const proj = await mkProject([{ ...baseRow, status: '待办' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, reply: 'x', resume: true }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /仅适用于/);
});

test('POST /reply id 未找到 → 400', async () => {
  const proj = await mkProject([{ ...baseRow, status: '阻塞-等答疑' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 999, reply: 'x' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /未找到/);
});
