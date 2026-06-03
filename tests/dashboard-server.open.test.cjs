'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-open-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');
// 不要真的 spawn 编辑器——否则每跑一次测试就往 VS Code/Trae 弹一个 opentgt-XXXX 空白标签页。
process.env.TASK_QUEUE_OPEN_DISABLED = '1';

const { startServer } = require('../commands/dashboard-server.cjs');

let inst;
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
  delete process.env.TASK_QUEUE_OPEN_DISABLED;
});

test('POST /api/open 合法 target 返回 200（TASK_QUEUE_OPEN_DISABLED 下不真的 spawn 编辑器）', async () => {
  inst = await startServer({ port: 0 });

  // 造一个临时目录做 target；因 TASK_QUEUE_OPEN_DISABLED=1，handler 走护栏分支
  // 直接返回 200 而不 spawn，避免污染开发者的编辑器窗口。
  const target = fs.mkdtempSync(path.join(tmpDir, 'opentgt-'));
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('POST /api/open target 缺失 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /api/open target 以 - 开头 → 400（防止当作 open 的 flag）', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: '-a Safari' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/open target 空白字符串 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: '   ' }),
  });
  assert.equal(res.status, 400);
});
