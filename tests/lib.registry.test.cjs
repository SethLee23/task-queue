'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { add, remove, list, update, getRegistryPath, getDesiredModelByRoot, VALID_MODELS, DEFAULT_MODEL } = require('../lib/registry.cjs');

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

test('add 新条目默认 desiredModel = opus', () => {
  const e = add('/tmp/proj-default-model');
  assert.equal(e.desiredModel, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'opus');
  assert.deepEqual(VALID_MODELS, ['opus', 'sonnet', 'haiku']);
});

test('update 合法 desiredModel 写回 registry', () => {
  const e = add('/tmp/proj-update-model');
  const updated = update(e.slug, { desiredModel: 'sonnet' });
  assert.equal(updated.desiredModel, 'sonnet');
  const found = list().find(p => p.slug === e.slug);
  assert.equal(found.desiredModel, 'sonnet');
});

test('update 非法 desiredModel 抛错且不持久化', () => {
  const e = add('/tmp/proj-bad-model');
  assert.throws(() => update(e.slug, { desiredModel: 'gpt' }), /不支持的 desiredModel/);
  const found = list().find(p => p.slug === e.slug);
  assert.equal(found.desiredModel, DEFAULT_MODEL);
});

test('update 不存在 slug 抛错', () => {
  assert.throws(() => update('nonexistent', { desiredModel: 'haiku' }), /未找到 slug/);
});

test('list 对旧 entry 缺失 desiredModel 字段自动补默认', () => {
  const p = getRegistryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version: 1,
    projects: [{ slug: 'legacy', root: '/tmp/legacy', name: 'legacy', registeredAt: '2025-01-01T00:00:00Z' }],
  }) + '\n');
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].desiredModel, DEFAULT_MODEL);
});

test('getDesiredModelByRoot 找到条目时返回其 desiredModel', () => {
  const e = add('/tmp/proj-by-root');
  update(e.slug, { desiredModel: 'haiku' });
  assert.equal(getDesiredModelByRoot('/tmp/proj-by-root'), 'haiku');
});

test('getDesiredModelByRoot 找不到条目时回退 DEFAULT_MODEL', () => {
  assert.equal(getDesiredModelByRoot('/tmp/never-registered'), DEFAULT_MODEL);
});
