'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const listCmd = require('../commands/dashboard-list.cjs');
const { add } = require('../lib/registry.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-cmd-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('list 空注册表输出 {projects:[]}', async () => {
  const out = await captureStdout(() => listCmd(undefined, []));
  assert.deepEqual(JSON.parse(out), { projects: [] });
});

test('list 输出所有已注册项目', async () => {
  add('/tmp/proj-a');
  add('/tmp/proj-b');
  const out = await captureStdout(() => listCmd(undefined, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.projects.length, 2);
});
