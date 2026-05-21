'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const unregisterCmd = require('../commands/dashboard-unregister.cjs');
const { add, list } = require('../lib/registry.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unreg-cmd-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('unregister 删除已注册 slug 并输出 JSON', async () => {
  add('/tmp/proj-a');
  const out = await captureStdout(() => unregisterCmd(undefined, ['proj-a']));
  const parsed = JSON.parse(out);
  assert.equal(parsed.removed, 'proj-a');
  assert.equal(list().length, 0);
});

test('unregister 不存在 slug 不抛错', async () => {
  const out = await captureStdout(() => unregisterCmd(undefined, ['no-such']));
  const parsed = JSON.parse(out);
  assert.equal(parsed.removed, 'no-such');
});

test('unregister 缺 slug 参数抛错', async () => {
  await assert.rejects(() => unregisterCmd(undefined, []), /slug/);
});
