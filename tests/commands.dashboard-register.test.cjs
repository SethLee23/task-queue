'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const registerCmd = require('../commands/dashboard-register.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-cmd-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('register 输出新条目 JSON', async () => {
  const out = await captureStdout(() => registerCmd('/tmp/proj-a', []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.slug, 'proj-a');
  assert.equal(parsed.root, '/tmp/proj-a');
});

test('register 同 root 第二次返回相同条目（幂等）', async () => {
  const out1 = await captureStdout(() => registerCmd('/tmp/proj-x', []));
  const out2 = await captureStdout(() => registerCmd('/tmp/proj-x', []));
  assert.equal(JSON.parse(out1).slug, JSON.parse(out2).slug);
});
