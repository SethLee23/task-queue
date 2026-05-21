'use strict';

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const testPushCmd = require('../commands/test-push.cjs');
const { captureStdout } = require('./_helpers.cjs');

// 所有用例都走 dry-run 模式，不实际触发本机通知；
// 通过 TASK_QUEUE_PUSH_CHANNEL 强制通道，避免被本机 terminal-notifier 安装与否左右测试结果。
beforeEach(() => {
  process.env.TASK_QUEUE_TEST_DRYRUN = '1';
  process.env.TASK_QUEUE_PUSH_CHANNEL = 'osascript';
});
afterEach(() => {
  delete process.env.TASK_QUEUE_TEST_DRYRUN;
  delete process.env.TASK_QUEUE_PUSH_CHANNEL;
  delete process.env.TASK_QUEUE_DIALOG_TIMEOUT;
});

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

test('test-push 强制 terminal-notifier 通道时 dry-run 标记通道为 terminal-notifier', { skip: !isDarwin && 'macOS only' }, async () => {
  process.env.TASK_QUEUE_PUSH_CHANNEL = 'terminal-notifier';
  const out = await captureStdout(() => testPushCmd('强制通道', []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.channel, 'terminal-notifier');
  assert.equal(parsed.dryRun, true);
});

test('test-push 不指定通道时默认走 system-events-dialog（dry-run 输出 timeoutSec）', { skip: !isDarwin && 'macOS only' }, async () => {
  delete process.env.TASK_QUEUE_PUSH_CHANNEL;
  const out = await captureStdout(() => testPushCmd('默认通道', []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.channel, 'system-events-dialog');
  assert.equal(parsed.timeoutSec, 5);
  assert.equal(parsed.dryRun, true);
});

test('test-push system-events-dialog 通道支持 TASK_QUEUE_DIALOG_TIMEOUT 覆盖默认 5 秒', { skip: !isDarwin && 'macOS only' }, async () => {
  process.env.TASK_QUEUE_PUSH_CHANNEL = 'system-events-dialog';
  process.env.TASK_QUEUE_DIALOG_TIMEOUT = '12';
  const out = await captureStdout(() => testPushCmd('自定义超时', []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.channel, 'system-events-dialog');
  assert.equal(parsed.timeoutSec, 12);
});
