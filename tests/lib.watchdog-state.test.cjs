'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-state-'));
process.env.TASK_QUEUE_WATCHDOG_STATE_PATH = path.join(tmp, 'watchdog-state.json');
const ws = require('../lib/watchdog-state.cjs');

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.TASK_QUEUE_WATCHDOG_STATE_PATH; });
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_WATCHDOG_STATE_PATH); } catch (_) {} });

test('文件不存在 → 空对象', () => {
  assert.deepEqual(ws.readState(), {});
});

test('write 后 read 回来一致', () => {
  ws.writeState({ demo: { consecutive: 2, lastRestartAt: 123, gaveUp: false } });
  assert.deepEqual(ws.readState(), { demo: { consecutive: 2, lastRestartAt: 123, gaveUp: false } });
});

test('文件损坏 → 当空对象，不抛', () => {
  fs.writeFileSync(process.env.TASK_QUEUE_WATCHDOG_STATE_PATH, '{ not json');
  assert.deepEqual(ws.readState(), {});
});
