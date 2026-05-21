// commands/test-push.cjs — 随时测试桌面通知通道
//
// 用法：node tasks.cjs test-push [message]
//
// 走系统原生 API（macOS 用 osascript），不经过 Claude 的 PushNotification，
// 因此不受 60s 反打扰门控限制 —— 用户/Claude 都可以随时调用验证桌面通知通道。
//
// 非 macOS 平台目前不支持（未来可扩展 notify-send / powershell.exe -Command）。
//
// 测试时设环境变量 TASK_QUEUE_TEST_DRYRUN=1，可跳过 osascript 实际调用，
// 仅返回 JSON 结果（便于单元测试，不污染本机通知中心）。

'use strict';

const { execFileSync } = require('node:child_process');
const os = require('node:os');

/**
 * 触发一条系统原生桌面通知。
 *
 * @param {string|undefined} messageArg dispatcher 传来的第一个用户参数（test-push 不需要
 *   projectRoot，dispatcher 把首参塞在这一位）。为空则用默认带时间戳的消息。
 * @param {string[]} _args 剩余参数（暂未使用）
 * @returns {Promise<void>}
 */
module.exports = async function testPush(messageArg, _args) {
  const message = messageArg || `task-queue 通知测试 — ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  const title = 'task-queue';

  const platform = os.platform();
  if (platform !== 'darwin') {
    process.stderr.write(`[task-queue] test-push 当前仅支持 macOS（detected: ${platform}）\n`);
    process.exit(1);
  }

  // dry-run 模式：跳过实际 osascript 调用，仅返回 JSON（用于单元测试）
  if (process.env.TASK_QUEUE_TEST_DRYRUN === '1') {
    process.stdout.write(JSON.stringify({
      ok: true, channel: 'osascript', title, message, dryRun: true,
    }) + '\n');
    return;
  }

  // JSON.stringify 对 AppleScript 字符串字面量足够安全（同样转义 \ 和 "）
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`;
  try {
    execFileSync('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`osascript 调用失败: ${e.message}`);
  }
  process.stdout.write(JSON.stringify({
    ok: true, channel: 'osascript', title, message,
  }) + '\n');
};
