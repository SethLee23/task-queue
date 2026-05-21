'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const heartbeatCmd = require('../commands/heartbeat.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cmd-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  return p;
}

test('heartbeat 子命令默认写 phase=idle', async () => {
  const proj = mkProj();
  const out = await captureStdout(() => heartbeatCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
});

test('heartbeat --phase sleeping 写指定 phase', async () => {
  const proj = mkProj();
  await captureStdout(() => heartbeatCmd(proj, ['--phase', 'sleeping']));
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'sleeping');
});

test('heartbeat 非法 phase 抛错', async () => {
  const proj = mkProj();
  await assert.rejects(() => heartbeatCmd(proj, ['--phase', 'bogus']), /phase/);
});
