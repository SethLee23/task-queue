'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync: realExecFileSync } = require('node:child_process');
const { writeHeartbeat } = require('./heartbeat.cjs');

const LOOP_PROMPT_PATH = path.join(__dirname, '..', 'loop-prompt.md');

/** slug → tmux session 名。 */
function sessionName(slug) {
  return `task-queue-loop-${slug}`;
}

/** POSIX 单引号转义。 */
function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** 读 loop-prompt.md，替换 ${PROJECT_ROOT}，去尾部空白。 */
function buildLoopPrompt(root) {
  let prompt = fs.readFileSync(LOOP_PROMPT_PATH, 'utf8');
  prompt = prompt.replace(/\$\{PROJECT_ROOT\}/g, root);
  return prompt.replace(/\s+$/, '');
}

/** send-keys 那一行（外层 bash 双引号串；$(cat …) 留给 tmux 内 shell 展开）。 */
function sendKeysLine() {
  return 'tmux send-keys -t "$SESSION" '
    + '"claude --dangerously-skip-permissions \\"/loop \\$(cat \'$PROMPT_FILE\')\\"" '
    + 'Enter';
}

/** 人用：可粘贴的 tmux 四段启动脚本（含 attach）。 */
function renderStartScript(root, slug) {
  const prompt = buildLoopPrompt(root);
  return [
    `SESSION='${sessionName(slug)}'`,
    `PROMPT_FILE="\${TMPDIR:-/tmp}/tq-loop-${slug}.prompt"`,
    `cat > "$PROMPT_FILE" <<'TQ_PROMPT_END'`,
    prompt,
    `TQ_PROMPT_END`,
    `tmux new-session -ds "$SESSION" -c ${shellSingleQuote(root)} "$SHELL"`,
    sendKeysLine(),
    `tmux attach -t "$SESSION"`,
  ].join('\n');
}

/**
 * 无头启动 loop：写 prompt 文件 → tmux new-session -ds → send-keys。绝不 attach。
 * @param {string} root 项目根
 * @param {string} slug
 * @param {Function} [execFileSyncImpl] 注入用，默认真实 execFileSync
 * @returns {string} session 名
 * @throws 若同名 tmux session 已存在（new-session 失败）；调用方须先确保 session 不存在（看门狗在调用前会 kill-session）。
 */
function launchHeadless(root, slug, execFileSyncImpl = realExecFileSync) {
  const session = sessionName(slug);
  const promptFile = path.join(os.tmpdir(), `tq-loop-${slug}.prompt`);
  fs.writeFileSync(promptFile, buildLoopPrompt(root));
  const shell = process.env.SHELL || '/bin/zsh';
  execFileSyncImpl('tmux', ['new-session', '-ds', session, '-c', root, shell], { stdio: 'ignore' });
  const claudeLine = `claude --dangerously-skip-permissions "/loop $(cat '${promptFile}')"`;
  execFileSyncImpl('tmux', ['send-keys', '-t', session, claudeLine, 'Enter'], { stdio: 'ignore' });
  // 新会话起步：归零 rounds（watchdog 重启 / dashboard 起按钮都经此，保证轮数反映当前会话）。
  // 仅对已 init 的真实项目写（.tasks 不存在则跳过，避免测试用假路径产生副作用）。
  if (fs.existsSync(path.join(root, '.tasks'))) {
    writeHeartbeat(root, { resetRounds: true });
  }
  return session;
}

module.exports = { sessionName, shellSingleQuote, buildLoopPrompt, renderStartScript, launchHeadless };
