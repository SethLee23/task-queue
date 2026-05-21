'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-write-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProj(rows) {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  const xlsx = path.join(p, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  await withWorkbook(xlsx, async wb => {
    rows.forEach(r => wb.getWorksheet(SHEET_IN_PROGRESS).addRow(r));
  });
  return p;
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST skip 把 待办 改为 跳过', async () => {
  const proj = await mkProj([
    { id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办' },
  ]);
  const entry = registryAdd(proj);
  inst = await startServer({ port: 0 });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/skip`, { id: 1 });
  assert.equal(res.status, 200);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '跳过');
});

test('POST skip 非 待办 → 409', async () => {
  const proj = await mkProj([
    { id: 2, desc: 'b', scope: 'web', priority: '中', status: '进行中' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/skip`, { id: 2 });
  assert.equal(res.status, 409);
});

test('POST skip id 不存在 → 404', async () => {
  const proj = await mkProj([]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/skip`, { id: 99 });
  assert.equal(res.status, 404);
});

test('POST priority 改 待办 任务优先级', async () => {
  const proj = await mkProj([
    { id: 3, desc: 'c', scope: 'web', priority: '中', status: '待办' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/priority`,
    { id: 3, priority: '高' },
  );
  assert.equal(res.status, 200);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].priority, '高');
});

test('POST priority 非法值 → 400', async () => {
  const proj = await mkProj([
    { id: 4, desc: 'd', scope: 'web', priority: '中', status: '待办' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/priority`,
    { id: 4, priority: '紧急' },
  );
  assert.equal(res.status, 400);
});

test('POST skip 非法 JSON body → 400', async () => {
  const proj = await mkProj([]);
  registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const entry = require('../lib/registry.cjs').list()[0];
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-json{',
  });
  assert.equal(res.status, 400);
});
