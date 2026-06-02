// tests/dashboard-server.mark-done.test.cjs
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-mark-done-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const {
  createBlankWorkbook, withWorkbook, readRows,
  SHEET_IN_PROGRESS, SHEET_ARCHIVED,
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
  note: '原备注', question: '', risk: '',
  ctime: '2026-05-21T10:00:00Z', ftime: '',
};

test('POST /mark-done 把 review 任务归档', async () => {
  const proj = await mkProject([{ ...baseRow, status: '已完成-待review', risk: 'r' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/mark-done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, summary: '复测过' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.task.status, '已完成');
  assert.equal(body.task.fromStatus, '已完成-待review');

  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg.length, 0);
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(arch.length, 1);
  assert.equal(arch[0].status, '已完成');
  assert.match(String(arch[0].note), /手动标记完成（来自待 review）/);
});

test('POST /mark-done 把 blocked 任务归档', async () => {
  const proj = await mkProject([{ ...baseRow, status: '阻塞-等答疑', question: 'q?' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/mark-done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, summary: '已确认' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.task.fromStatus, '阻塞-等答疑');

  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(arch.length, 1);
  assert.match(String(arch[0].note), /原 Q: q\?/);
});

test('POST /mark-done id 缺失 → 400', async () => {
  const proj = await mkProject([{ ...baseRow, status: '已完成-待review' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/mark-done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: 'x' }),
  });
  assert.equal(res.status, 400);
});

test('POST /mark-done summary 为空 → 400', async () => {
  const proj = await mkProject([{ ...baseRow, status: '已完成-待review' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/mark-done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, summary: '   ' }),
  });
  assert.equal(res.status, 400);
});

test('POST /mark-done 项目不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/no-such/mark-done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, summary: 'x' }),
  });
  assert.equal(res.status, 404);
});

test('POST /mark-done 非 review/blocked 状态 → 400', async () => {
  const proj = await mkProject([{ ...baseRow, status: '待办' }]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/mark-done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, summary: 'x' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /仅适用于/);
});
