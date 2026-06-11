'use strict';

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeHeartbeat, readHeartbeat } = require('../lib/heartbeat.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  return p;
}

beforeEach(() => { process.env.CLAUDE_MODEL = 'claude-opus-4-7'; });
afterEach(() => { delete process.env.CLAUDE_MODEL; });

test('writeHeartbeat 写入并能 readHeartbeat 读回', async () => {
  const proj = mkProj();
  const ok = writeHeartbeat(proj, { phase: 'executing', currentTaskId: 12, currentTaskDesc: 'foo' });
  assert.equal(ok, true);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'executing');
  assert.equal(hb.currentTaskId, 12);
  assert.equal(hb.model, 'claude-opus-4-7');
  assert.match(hb.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('writeHeartbeat 合并 — 不在 patch 里的字段保留', async () => {
  const proj = mkProj();
  writeHeartbeat(proj, { phase: 'executing', currentTaskId: 12, lastFinishedId: 11 });
  writeHeartbeat(proj, { phase: 'idle', currentTaskId: null });
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
  assert.equal(hb.currentTaskId, null);
  assert.equal(hb.lastFinishedId, 11, 'lastFinishedId 应被保留');
});

test('CLAUDE_MODEL 缺失时保留旧 model', async () => {
  const proj = mkProj();
  writeHeartbeat(proj, { phase: 'executing' });
  delete process.env.CLAUDE_MODEL;
  writeHeartbeat(proj, { phase: 'idle' });
  const hb = readHeartbeat(proj);
  assert.equal(hb.model, 'claude-opus-4-7', 'model 应保留 first write 的值');
});

test('readHeartbeat 文件不存在返回 null', () => {
  const proj = mkProj();
  assert.equal(readHeartbeat(proj), null);
});

test('writeHeartbeat 目标目录不存在仍返回 false 不抛', () => {
  const ok = writeHeartbeat('/nonexistent/path', { phase: 'idle' });
  assert.equal(ok, false);
});

test('stopped 标记：显式置位 → 任何唤醒/启动自动清除', () => {
  const proj = mkProj();
  // 停：置 stopped
  writeHeartbeat(proj, { stopped: true });
  assert.equal(readHeartbeat(proj).stopped, true);
  // 不带控制位的普通写入应保留 stopped
  writeHeartbeat(proj, { phase: 'idle' });
  assert.equal(readHeartbeat(proj).stopped, true, '普通写入应保留 stopped');
  // 唤醒（heartbeat 命令的 incrementRound）→ 清除
  writeHeartbeat(proj, { phase: 'idle', incrementRound: true });
  assert.equal(readHeartbeat(proj).stopped, false, 'incrementRound 应清除 stopped');
});

test('stopped 标记：resetRounds（启动）也清除', () => {
  const proj = mkProj();
  writeHeartbeat(proj, { stopped: true });
  writeHeartbeat(proj, { resetRounds: true });
  assert.equal(readHeartbeat(proj).stopped, false);
});
