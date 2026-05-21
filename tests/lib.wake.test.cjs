'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { setWakeNow, clearWakeNow, readWakeNow, wakeNowPath } = require('../lib/wake.cjs');

function mkProj() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-test-'));
  fs.mkdirSync(path.join(p, '.tasks'));
  return p;
}

test('wakeNowPath 返回 .tasks/run/wake-now', () => {
  const proj = mkProj();
  assert.equal(wakeNowPath(proj), path.join(proj, '.tasks', 'run', 'wake-now'));
});

test('setWakeNow 写文件含 reason 并自动创建 run/ 目录', () => {
  const proj = mkProj();
  setWakeNow(proj, '面板立即执行');
  const p = wakeNowPath(proj);
  assert.equal(fs.existsSync(p), true);
  assert.equal(fs.readFileSync(p, 'utf8'), '面板立即执行');
});

test('setWakeNow reason 为空也能写', () => {
  const proj = mkProj();
  setWakeNow(proj);
  assert.equal(fs.readFileSync(wakeNowPath(proj), 'utf8'), '');
});

test('readWakeNow 无文件返回 null', () => {
  const proj = mkProj();
  assert.equal(readWakeNow(proj), null);
});

test('readWakeNow 有文件返回内容', () => {
  const proj = mkProj();
  setWakeNow(proj, 'hello');
  assert.equal(readWakeNow(proj), 'hello');
});

test('clearWakeNow 幂等：旗子存在删除、不存在不报错', () => {
  const proj = mkProj();
  setWakeNow(proj, 'x');
  clearWakeNow(proj);
  assert.equal(fs.existsSync(wakeNowPath(proj)), false);
  // 再调一次不抛
  assert.doesNotThrow(() => clearWakeNow(proj));
});
