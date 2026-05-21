'use strict';

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const testPushCmd = require('../commands/test-push.cjs');
const { captureStdout } = require('./_helpers.cjs');

// 所有用例都走 dry-run 模式，不实际触发本机通知
beforeEach(() => { process.env.TASK_QUEUE_TEST_DRYRUN = '1'; });
afterEach(() => { delete process.env.TASK_QUEUE_TEST_DRYRUN; });

const isDarwin = os.platform() === 'darwin';

test('test-push 默认消息含 "task-queue 通知测试" 前缀和时间戳', { skip: !isDarwin && 'macOS only' }, async () => {
  const out = await captureStdout(() => testPushCmd(undefined, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.channel, 'osascript');
  assert.equal(parsed.title, 'task-queue');
  assert.match(parsed.message, /^task-queue 通知测试 — \d{2}:\d{2}:\d{2}$/);
  assert.equal(parsed.dryRun, true);
});

test('test-push 自定义消息原样透传', { skip: !isDarwin && 'macOS only' }, async () => {
  const out = await captureStdout(() => testPushCmd('自定义内容', []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.message, '自定义内容');
});

test('test-push 消息含双引号 / 反斜杠时安全转义（不抛错）', { skip: !isDarwin && 'macOS only' }, async () => {
  const out = await captureStdout(() => testPushCmd('含"引号"和\\反斜杠', []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.message, '含"引号"和\\反斜杠');
});
