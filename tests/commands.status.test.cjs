'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const statusCmd = require('../commands/status.cjs');
const { setPaused } = require('../lib/paused.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pause-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  await createBlankWorkbook(path.join(p, '.tasks', 'tasks.xlsx'));
  return p;
}

test('status 默认 paused=false', async () => {
  const proj = await mkProj();
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.paused, false);
  assert.equal(parsed.pauseReason, null);
});

test('status 在 paused flag 文件存在时报 paused=true 含 reason', async () => {
  const proj = await mkProj();
  setPaused(proj, '人工暂停');
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.paused, true);
  assert.equal(parsed.pauseReason, '人工暂停');
});
