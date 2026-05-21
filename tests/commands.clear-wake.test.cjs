'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const clearWake = require('../commands/clear-wake.cjs');
const { setWakeNow, readWakeNow } = require('../lib/wake.cjs');
const { captureStdout } = require('./_helpers.cjs');

function mkProj() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-wake-test-'));
  fs.mkdirSync(path.join(p, '.tasks'));
  return p;
}

test('clear-wake 旗子在 → 被清掉并输出 ok', async () => {
  const proj = mkProj();
  setWakeNow(proj, 'test');
  assert.equal(readWakeNow(proj), 'test');
  const out = await captureStdout(() => clearWake(proj, []));
  assert.equal(readWakeNow(proj), null);
  assert.match(out, /ok/);
});

test('clear-wake 旗子不在 → 幂等不抛错', async () => {
  const proj = mkProj();
  const out = await captureStdout(() => clearWake(proj, []));
  assert.equal(readWakeNow(proj), null);
  assert.match(out, /ok/);
});
