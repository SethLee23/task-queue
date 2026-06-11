'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer, __setExecFileSyncImpl } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { readPaused } = require('../lib/paused.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-ssw-test-'));
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

// ---------- stop ----------

test('POST stop: 写暂停旗子 + tmux kill-session → killed:true', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl((cmd, args) => { execCalls.push({ cmd, args: [...args] }); return ''; });

  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/stop`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.killed, true);
  assert.equal(body.paused, true);

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].cmd, 'tmux');
  assert.equal(execCalls[0].args[0], 'kill-session');
  assert.equal(execCalls[0].args[2], `task-queue-loop-${entry.slug}`);

  assert.equal(readPaused(proj), '面板停止 loop');
  // stopped 标记应写入，且项目立即判离线（不等心跳 90min 过期）
  assert.equal(readHeartbeat(proj).stopped, true);
  const list = await fetch(`http://127.0.0.1:${inst.port}/api/projects`).then(r => r.json());
  const me = list.projects.find(p => p.slug === entry.slug);
  assert.equal(me.online, 'offline', '停 loop 后应立即显示 offline');
});

test('POST stop: 无 session(kill 抛错) → 仍 ok，killed:false，旗子已写', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl(() => { throw new Error("can't find session"); });

  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/stop`, { reason: '自定义原因' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.killed, false);
  assert.equal(readPaused(proj), '自定义原因');
});

test('POST stop: slug 不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl(() => { throw new Error('should not be called'); });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/no-such/stop`, {});
  assert.equal(res.status, 404);
});

// ---------- start ----------

test('POST start: 无 session → 清旗子 + launchHeadless 冷启，restarted:false', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  // 先写一个暂停旗子，验证 start 会清掉
  fs.writeFileSync(path.join(proj, '.tasks', 'run', 'loop-paused'), '停过');
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl((cmd, args) => {
    execCalls.push({ cmd, args: [...args] });
    if (args[0] === 'has-session') throw new Error('no session');
    return '';
  });

  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/start`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.restarted, false);

  const cmds = execCalls.map(c => c.args[0]);
  assert.ok(cmds.includes('has-session'), '应先探测 session');
  assert.ok(cmds.includes('new-session'), '应 new-session 冷启');
  assert.ok(cmds.includes('send-keys'), '应 send-keys 注入 claude /loop');
  assert.ok(!cmds.includes('kill-session'), '无 session 不应 kill');

  assert.equal(readPaused(proj), null, '暂停旗子应被清除');
});

test('POST start: session 已存在 → 先 kill 再起，restarted:true', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl((cmd, args) => {
    execCalls.push({ cmd, args: [...args] });
    return ''; // has-session 成功 = session 存在
  });

  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/start`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.restarted, true);

  const cmds = execCalls.map(c => c.args[0]);
  assert.ok(cmds.includes('kill-session'), '已存在应先 kill');
  assert.ok(cmds.includes('new-session'), '应重新 new-session');
  // 顺序：kill-session 必须在 new-session 之前
  assert.ok(cmds.indexOf('kill-session') < cmds.indexOf('new-session'), 'kill 应在 new 之前');
});

// ---------- watchdog ----------

test('GET /api/watchdog: 透传 watchdog status JSON', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl((cmd, args) => {
    assert.equal(cmd, process.execPath);
    assert.equal(args[args.length - 1], 'status');
    return JSON.stringify({ ok: true, loaded: true, plist: '/x.plist', state: {} });
  });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/watchdog`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.loaded, true);
});

test('POST /api/watchdog install: 调 watchdog install 并透传结果', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl((cmd, args) => {
    assert.equal(args[args.length - 1], 'install');
    return JSON.stringify({ ok: true, action: 'install' });
  });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/watchdog`, { action: 'install' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action, 'install');
});

test('POST /api/watchdog: 非法 action → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  __setExecFileSyncImpl(() => { throw new Error('should not be called'); });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/watchdog`, { action: 'frobnicate' });
  assert.equal(res.status, 400);
});
