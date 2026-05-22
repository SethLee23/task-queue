#!/usr/bin/env node
// tasks.cjs - task-queue skill 统一 CLI 入口

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const SKILL_DIR = __dirname;

function ensureDeps() {
  const exceljsPath = path.join(SKILL_DIR, 'node_modules', 'exceljs');
  if (!fs.existsSync(exceljsPath)) {
    process.stderr.write('[task-queue] 首次使用，安装依赖中...\n');
    execSync('npm install --omit=dev', { cwd: SKILL_DIR, stdio: 'inherit' });
  }
}

const KNOWN_COMMANDS = [
  'detect', 'init-write', 'next', 'claim', 'done', 'review',
  'block', 'reply', 'status', 'sweep', 'recover', 'add-row', 'test-push',
  'dashboard', 'heartbeat', 'clear-wake',
  'set-desired-model', 'set-task-model',
];

/** 不需要 <project-root> 参数的命令集合 */
const COMMANDS_NOT_REQUIRING_PROJECT_ROOT = new Set(['detect', 'init-write', 'test-push', 'dashboard']);

async function main() {
  const [, , cmd, projectRoot, ...rest] = process.argv;

  if (!cmd) {
    process.stderr.write('用法: tasks.cjs <command> <project-root> [args...]\n');
    process.stderr.write(`可用命令: ${KNOWN_COMMANDS.join(', ')}\n`);
    process.exit(2);
  }

  if (!KNOWN_COMMANDS.includes(cmd)) {
    process.stderr.write(`未知命令: ${cmd}\n`);
    process.exit(2);
  }

  if (!COMMANDS_NOT_REQUIRING_PROJECT_ROOT.has(cmd) && !projectRoot) {
    process.stderr.write(`命令 ${cmd} 需要 <project-root> 参数\n`);
    process.exit(2);
  }

  ensureDeps();

  const handler = require(`./commands/${cmd}.cjs`);
  await handler(projectRoot, rest);
}

main().catch(err => {
  process.stderr.write(`[task-queue] 错误: ${err.message}\n`);
  if (process.env.TASK_QUEUE_DEBUG) {
    process.stderr.write(err.stack + '\n');
  }
  // 尝试写日志（如果 project root 有 .tasks/）
  const projectRoot = process.argv[3];
  if (projectRoot && fs.existsSync(path.join(projectRoot, '.tasks'))) {
    try {
      const { Logger } = require('./lib/logger.cjs');
      new Logger(projectRoot).error(`CLI 异常: ${err.message}`);
    } catch (_) { /* 日志失败不再传播 */ }
  }
  process.exit(1);
});
