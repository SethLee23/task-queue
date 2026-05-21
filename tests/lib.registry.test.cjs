'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { add, remove, list, getRegistryPath } = require('../lib/registry.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

beforeEach(() => {
  try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {}
});
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('add 首次创建注册表文件并加入条目', () => {
  const entry = add('/tmp/proj-a');
  assert.equal(entry.slug, 'proj-a');
  assert.equal(entry.root, '/tmp/proj-a');
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'proj-a');
});

test('add 同 root 第二次 = 幂等（不重复，返回原条目）', () => {
  const a = add('/tmp/proj-x');
  const b = add('/tmp/proj-x');
  assert.equal(a.slug, b.slug);
  assert.equal(a.registeredAt, b.registeredAt);
  assert.equal(list().length, 1);
});

test('slug 碰撞 → 追加 -2', () => {
  add('/path1/dup');
  const second = add('/path2/dup');
  assert.equal(second.slug, 'dup-2');
});

test('remove 按 slug 删除', () => {
  add('/tmp/x');
  add('/tmp/y');
  remove('x');
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'y');
});

test('remove 不存在的 slug 不抛错（幂等）', () => {
  add('/tmp/x');
  remove('nonexistent');
  assert.equal(list().length, 1);
});

test('list 在文件不存在时返回空数组', () => {
  assert.deepEqual(list(), []);
});
