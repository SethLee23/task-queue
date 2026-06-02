'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-hidden-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

const { setHiddenCore, setHiddenBySlug } = require('../commands/set-hidden.cjs');
const { add, list } = require('../lib/registry.cjs');

beforeEach(() => {
  try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {}
});
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('setHiddenCore 写 true 后 registry 持久化 hidden:true', () => {
  const e = add('/tmp/proj-hidden-1');
  const res = setHiddenCore('/tmp/proj-hidden-1', true);
  assert.equal(res.slug, e.slug);
  assert.equal(res.hidden, true);
  const persisted = list().find(p => p.slug === e.slug);
  assert.equal(persisted.hidden, true);
});

test('setHiddenCore 写 false 后 hidden 翻回 false', () => {
  add('/tmp/proj-hidden-2');
  setHiddenCore('/tmp/proj-hidden-2', true);
  setHiddenCore('/tmp/proj-hidden-2', false);
  const persisted = list().find(p => p.root === '/tmp/proj-hidden-2');
  assert.equal(persisted.hidden, false);
});

test('setHiddenCore 非 boolean 入参抛错且不持久化', () => {
  const e = add('/tmp/proj-hidden-3');
  assert.throws(() => setHiddenCore('/tmp/proj-hidden-3', 'true'), /必须是 boolean/);
  assert.throws(() => setHiddenCore('/tmp/proj-hidden-3', 1), /必须是 boolean/);
  const persisted = list().find(p => p.slug === e.slug);
  assert.equal(persisted.hidden, false);
});

test('setHiddenCore 项目未在 registry 中抛错', () => {
  assert.throws(() => setHiddenCore('/tmp/never-registered-h', true), /registry 中未找到项目/);
});

test('setHiddenBySlug 等效写入 hidden 字段', () => {
  const e = add('/tmp/proj-hidden-4');
  const res = setHiddenBySlug(e.slug, true);
  assert.equal(res.hidden, true);
  const persisted = list().find(p => p.slug === e.slug);
  assert.equal(persisted.hidden, true);
});

test('新注册项目默认 hidden:false', () => {
  const e = add('/tmp/proj-hidden-5');
  assert.equal(e.hidden, false);
  const persisted = list().find(p => p.slug === e.slug);
  assert.equal(persisted.hidden, false);
});

test('list 走 normalize 自动补 hidden:false（兼容旧 registry 无 hidden 字段）', () => {
  fs.writeFileSync(process.env.TASK_QUEUE_REGISTRY_PATH, JSON.stringify({
    version: 1,
    projects: [{
      slug: 'legacy-proj',
      root: '/tmp/legacy',
      name: 'legacy',
      registeredAt: '2026-01-01T00:00:00.000Z',
      desiredModel: 'opus',
    }],
  }));
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].hidden, false);
});
