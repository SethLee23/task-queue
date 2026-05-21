'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-cleanup-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd, list: registryList } = require('../lib/registry.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

async function mkLiveProject() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'live-'));
  fs.mkdirSync(path.join(p, '.tasks'), { recursive: true });
  await createBlankWorkbook(path.join(p, '.tasks', 'tasks.xlsx'));
  return p;
}

function mkGhostPath() {
  return path.join(tmpDir, `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

test('POST /api/cleanup-missing 移除 root 不存在的项目，保留正常项目', async () => {
  const live = await mkLiveProject();
  registryAdd(live);
  registryAdd(mkGhostPath());
  registryAdd(mkGhostPath());
  assert.equal(registryList().length, 3);

  inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/cleanup-missing`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  assert.equal(body.removed.length, 2);

  const remaining = registryList();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].root, live);
});

test('POST /api/cleanup-missing root 存在但 .tasks 缺失也算 missing', async () => {
  const noTasks = fs.mkdtempSync(path.join(tmpDir, 'notasks-'));
  registryAdd(noTasks);

  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/cleanup-missing`, { method: 'POST' });
  const body = await res.json();

  assert.equal(body.count, 1);
  assert.equal(registryList().length, 0);
});

test('POST /api/cleanup-missing 空注册表时返回 count=0', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/cleanup-missing`, { method: 'POST' });
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.removed, []);
});

test('GET /api/cleanup-missing 不响应（仅 POST）', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/cleanup-missing`);
  assert.equal(res.status, 404);
});
