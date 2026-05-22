'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-desired-model-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

const { setDesiredModelCore } = require('../commands/set-desired-model.cjs');
const { add, list, DEFAULT_MODEL } = require('../lib/registry.cjs');

beforeEach(() => {
  try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {}
});
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('setDesiredModelCore 合法模型写回 registry 并返回 { slug, desiredModel }', () => {
  const e = add('/tmp/proj-sd-1');
  const res = setDesiredModelCore('/tmp/proj-sd-1', 'haiku');
  assert.equal(res.slug, e.slug);
  assert.equal(res.desiredModel, 'haiku');
  const persisted = list().find(p => p.slug === e.slug);
  assert.equal(persisted.desiredModel, 'haiku');
});

test('setDesiredModelCore 非法模型抛错且不持久化', () => {
  const e = add('/tmp/proj-sd-2');
  assert.throws(() => setDesiredModelCore('/tmp/proj-sd-2', 'gpt'), /不支持的模型/);
  const persisted = list().find(p => p.slug === e.slug);
  assert.equal(persisted.desiredModel, DEFAULT_MODEL);
});

test('setDesiredModelCore 项目未在 registry 中抛错', () => {
  assert.throws(() => setDesiredModelCore('/tmp/never-registered', 'sonnet'), /registry 中未找到项目/);
});

test('setDesiredModelCore 反复切换最终持久化最后一个值', () => {
  add('/tmp/proj-sd-3');
  setDesiredModelCore('/tmp/proj-sd-3', 'sonnet');
  setDesiredModelCore('/tmp/proj-sd-3', 'haiku');
  setDesiredModelCore('/tmp/proj-sd-3', 'opus');
  const persisted = list().find(p => p.root === '/tmp/proj-sd-3');
  assert.equal(persisted.desiredModel, 'opus');
});
