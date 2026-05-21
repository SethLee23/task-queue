'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../commands/dashboard-server.cjs');

let inst;
after(async () => { if (inst) await inst.close(); });

test('startServer 监听 port 0 自动分配端口', async () => {
  inst = await startServer({ port: 0, host: '127.0.0.1' });
  assert.ok(inst.port > 0);
});

test('GET / 返回 index.html 内容', async () => {
  if (!inst) inst = await startServer({ port: 0, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${inst.port}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /task-queue dashboard/);
});

test('GET 不存在路径返回 404', async () => {
  const res = await fetch(`http://127.0.0.1:${inst.port}/nope`);
  assert.equal(res.status, 404);
});

test('GET 路径穿越尝试被拦截', async () => {
  const res = await fetch(`http://127.0.0.1:${inst.port}/../../../etc/passwd`);
  assert.notEqual(res.status, 200);
});
