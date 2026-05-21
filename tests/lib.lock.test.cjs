'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withLock, acquireLock, releaseLock, LockTimeoutError } = require('../lib/lock.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('withLock 串行执行 — 第二个等第一个释放', async () => {
  const lockDir = path.join(tmpDir, 'lock1');
  const order = [];
  const p1 = withLock(lockDir, async () => {
    order.push('a-start');
    await new Promise(r => setTimeout(r, 80));
    order.push('a-end');
  });
  const p2 = withLock(lockDir, async () => {
    order.push('b-start');
    order.push('b-end');
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('withLock 释放锁即使 fn 抛错', async () => {
  const lockDir = path.join(tmpDir, 'lock2');
  await assert.rejects(() => withLock(lockDir, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lockDir), false, '锁目录应被释放');
});

test('acquireLock 自旋超过 5s 抛 LockTimeoutError', async () => {
  const lockDir = path.join(tmpDir, 'lock3');
  await acquireLock(lockDir);
  const t0 = Date.now();
  await assert.rejects(
    () => acquireLock(lockDir, { timeoutMs: 300, intervalMs: 50 }),
    err => err instanceof LockTimeoutError,
  );
  assert.ok(Date.now() - t0 >= 250, '应等待至少 ~timeoutMs');
  await releaseLock(lockDir);
});

test('stale 锁（info.ts > 30s 前）会被自动接管', async () => {
  const lockDir = path.join(tmpDir, 'lock4');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({
    pid: 99999, ts: new Date(Date.now() - 60000).toISOString(),
  }));
  await acquireLock(lockDir, { timeoutMs: 200, intervalMs: 50 });
  await releaseLock(lockDir);
});

test('isStale 不会误杀刚 mkdir 但 info.json 尚未写入的锁', async () => {
  const lockDir = path.join(tmpDir, 'lock-race');
  fs.mkdirSync(lockDir);
  const t0 = Date.now();
  await assert.rejects(
    () => acquireLock(lockDir, { timeoutMs: 200, intervalMs: 50 }),
    err => err instanceof LockTimeoutError,
  );
  assert.ok(Date.now() - t0 >= 150, '应等待 timeoutMs 而不是立刻接管刚 mkdir 的锁');
  fs.rmSync(lockDir, { recursive: true, force: true });
});
