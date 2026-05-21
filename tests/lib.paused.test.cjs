'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setPaused, clearPaused, readPaused } = require('../lib/paused.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paused-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  return p;
}

test('readPaused 文件不存在返回 null', () => {
  const proj = mkProj();
  assert.equal(readPaused(proj), null);
});

test('setPaused 后 readPaused 返回 reason', () => {
  const proj = mkProj();
  setPaused(proj, '手工暂停验证');
  assert.equal(readPaused(proj), '手工暂停验证');
});

test('clearPaused 删除文件后 readPaused 返回 null', () => {
  const proj = mkProj();
  setPaused(proj, 'foo');
  clearPaused(proj);
  assert.equal(readPaused(proj), null);
});

test('setPaused 覆盖原有 reason', () => {
  const proj = mkProj();
  setPaused(proj, 'a');
  setPaused(proj, 'b');
  assert.equal(readPaused(proj), 'b');
});

test('setPaused 空 reason 落地为空字符串（仍算暂停）', () => {
  const proj = mkProj();
  setPaused(proj, '');
  assert.equal(readPaused(proj), '');
});
