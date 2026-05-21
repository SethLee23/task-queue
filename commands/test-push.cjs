// commands/test-push.cjs — 随时测试桌面通知通道
//
// 用法：node tasks.cjs test-push [message]
//
// 走系统原生通道，不经过 Claude 的 PushNotification，因此不受 60s 反打扰门控限制 ——
// 用户/Claude 都可以随时调用验证桌面通知通道。
//
// macOS 通道优先级（默认按可见性从高到低）：
//   1) system-events-dialog（默认，最可靠）—— osascript 经 System Events 弹一个浮在
//      所有窗口最前的对话框，超时自动消失，不依赖通知中心权限；
//   2) terminal-notifier —— Homebrew 安装的通知应用，但 macOS 15 上对非 codesigned
//      应用静默拒绝注册（通知会被 -list ALL 查到但不显示横幅），仅在显式指定时使用；
//   3) osascript display notification —— 走通知中心，依赖 Script Editor.app 注册到
//      系统，macOS 15+ 部分机型该 app 缺失会静默丢弃，仅在显式指定时使用。
//
// 非 macOS 平台目前不支持（未来可扩展 notify-send / powershell.exe -Command）。
//
// 测试时设环境变量 TASK_QUEUE_TEST_DRYRUN=1，可跳过实际系统调用，
// 仅返回 JSON 结果（便于单元测试，不污染本机通知中心 / 屏幕）。
//
// 强制指定通道：TASK_QUEUE_PUSH_CHANNEL=system-events-dialog | terminal-notifier | osascript。
// dialog 超时：TASK_QUEUE_DIALOG_TIMEOUT 秒数（默认 5）。

'use strict';

const { execFileSync } = require('node:child_process');
const os = require('node:os');

/**
 * 检测 PATH 中是否存在某个可执行文件。
 *
 * @param {string} bin 可执行名
 * @returns {string|null} 命中时返回绝对路径，否则 null
 */
function which(bin) {
  try {
    const out = execFileSync('/usr/bin/which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

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

  const forced = process.env.TASK_QUEUE_PUSH_CHANNEL;
  const channel = forced || 'system-events-dialog';
  const dialogTimeout = Math.max(1, parseInt(process.env.TASK_QUEUE_DIALOG_TIMEOUT || '5', 10) || 5);

  // dry-run 模式：跳过实际系统调用，仅返回 JSON（用于单元测试）
  if (process.env.TASK_QUEUE_TEST_DRYRUN === '1') {
    process.stdout.write(JSON.stringify({
      ok: true, channel, title, message, dryRun: true,
      ...(channel === 'system-events-dialog' ? { timeoutSec: dialogTimeout } : {}),
    }) + '\n');
    return;
  }

  if (channel === 'system-events-dialog') {
    // 经 System Events 弹一个浮在最前的对话框，giving up after 自动消失。
    // JSON.stringify 对 AppleScript 字符串字面量足够安全（同样转义 \ 和 "）
    const script = `tell application "System Events" to display dialog ${JSON.stringify(message)} with title ${JSON.stringify(title)} buttons {"OK"} default button "OK" giving up after ${dialogTimeout}`;
    try {
      execFileSync('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`system-events-dialog 调用失败: ${e.message}`);
    }
    process.stdout.write(JSON.stringify({
      ok: true, channel: 'system-events-dialog', title, message, timeoutSec: dialogTimeout,
    }) + '\n');
    return;
  }

  if (channel === 'terminal-notifier') {
    const tnBin = which('terminal-notifier');
    if (!tnBin) {
      throw new Error('TASK_QUEUE_PUSH_CHANNEL=terminal-notifier 但 PATH 中找不到 terminal-notifier，请先 brew install terminal-notifier');
    }
    try {
      execFileSync(tnBin, [
        '-title', title,
        '-message', message,
        '-sound', 'Glass',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`terminal-notifier 调用失败: ${e.message}`);
    }
    process.stdout.write(JSON.stringify({ ok: true, channel: 'terminal-notifier', title, message }) + '\n');
    return;
  }

  if (channel === 'osascript') {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`;
    try {
      execFileSync('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`osascript 调用失败: ${e.message}`);
    }
    process.stdout.write(JSON.stringify({ ok: true, channel: 'osascript', title, message }) + '\n');
    return;
  }

  throw new Error(`未知通道: ${channel}（可选: system-events-dialog | terminal-notifier | osascript）`);
};
