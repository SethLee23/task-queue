'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer, __setExecFileSyncImpl } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { readWakeNow } = require('../lib/wake.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-scan-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
let execCalls = [];

beforeEach(() => {
  try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {}
  execCalls = [];
});

after(async () => {
  __setExecFileSyncImpl(null);
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  await createBlankWorkbook(path.join(p, '.tasks', 'tasks.xlsx'));
  return p;
}

async function postJson(u, body) {
  return fetch(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

test('POST scan-now: tmux has-session 成功 → send-keys 注入 → mode=tmux', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl((cmd, args) => {
    execCalls.push({ cmd, args: [...args] });
    return '';
  });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/scan-now`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'tmux');
  assert.equal(body.sessionName, `task-queue-loop-${entry.slug}`);

  assert.equal(execCalls.length, 2);
  assert.equal(execCalls[0].cmd, 'tmux');
  assert.equal(execCalls[0].args[0], 'has-session');
  assert.equal(execCalls[0].args[1], '-t');
  assert.equal(execCalls[0].args[2], `task-queue-loop-${entry.slug}`);

  assert.equal(execCalls[1].cmd, 'tmux');
  assert.equal(execCalls[1].args[0], 'send-keys');
  assert.equal(execCalls[1].args[1], '-t');
  assert.equal(execCalls[1].args[2], `task-queue-loop-${entry.slug}`);
  assert.equal(execCalls[1].args[3], '扫一下');
  assert.equal(execCalls[1].args[4], 'Enter');

  assert.equal(readWakeNow(proj), null);
});

test('POST scan-now: has-session 抛错(无 session) → 降级 wake-flag', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl((cmd, args) => {
    execCalls.push({ cmd, args: [...args] });
    throw new Error("can't find session: task-queue-loop-xxx");
  });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/scan-now`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'wake-flag');

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].args[0], 'has-session');

  assert.equal(readWakeNow(proj), '面板立即执行');
});

test('POST scan-now: tmux 二进制缺失(ENOENT) → 降级 wake-flag', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl(() => {
    const e = new Error('spawn tmux ENOENT');
    e.code = 'ENOENT';
    throw e;
  });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/scan-now`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'wake-flag');
  assert.equal(readWakeNow(proj), '面板立即执行');
});

test('POST scan-now: slug 不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl(() => { throw new Error('should not be called'); });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/no-such-proj/scan-now`, {});
  assert.equal(res.status, 404);
});

test('POST scan-now: slug 格式非法 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl(() => { throw new Error('should not be called'); });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/Bad%20Slug/scan-now`, {});
  assert.equal(res.status, 400);
});
