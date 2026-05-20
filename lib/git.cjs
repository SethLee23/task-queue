/**
 * git 操作封装模块
 *
 * 所有命令失败时直接抛错（不吞），方便上层感知。
 * 内部 run() 仅供本模块使用，不 export。
 */

'use strict';

const { execFileSync } = require('node:child_process');

/**
 * 执行 git 子命令，失败时抛出含 stderr 信息的错误。
 * @param {string} cwd - 工作目录
 * @param {string[]} args - git 子命令及参数
 * @returns {string} 命令标准输出
 */
function run(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    const err = new Error(`git ${args.join(' ')} 失败: ${stderr || stdout || e.message}`);
    err.stderr = stderr;
    err.stdout = stdout;
    throw err;
  }
}

/**
 * 获取工作区改动文件列表（含未追踪文件）。
 * @param {string} cwd - git 仓库路径
 * @returns {string[]} 改动文件的相对路径数组，干净时返回空数组
 */
function gitStatus(cwd) {
  const out = run(cwd, ['status', '--porcelain=v1']);
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3).trim());
}

/**
 * 获取工作区 diff 的 stat 摘要（未暂存部分）。
 * @param {string} cwd - git 仓库路径
 * @returns {string} `git diff --stat` 的输出
 */
function gitDiffStat(cwd) {
  return run(cwd, ['diff', '--stat']);
}

/**
 * 暂存指定文件（`git add`）。
 * @param {string} cwd - git 仓库路径
 * @param {string[]} files - 要暂存的文件路径列表
 */
function gitAdd(cwd, files) {
  if (files.length === 0) return;
  run(cwd, ['add', '--', ...files]);
}

/**
 * 创建 commit，commit 失败（包括 hook 拦截）时抛错。
 * @param {string} cwd - git 仓库路径
 * @param {string} message - commit 信息
 */
function gitCommit(cwd, message) {
  run(cwd, ['commit', '-m', message]);
}

/**
 * 获取最近 n 条 commit 的 subject 列表。
 * @param {string} cwd - git 仓库路径
 * @param {number} [n=50] - 取最近几条
 * @returns {string[]} commit subject 数组，最新在前
 */
function gitLogSubjects(cwd, n = 50) {
  const out = run(cwd, ['log', `-${n}`, '--pretty=%s']);
  return out.split('\n').filter(Boolean);
}

/**
 * 获取今天（本地时间）的 commit 日志，含 subject 和 body，条目间以 --- 分隔。
 * @param {string} cwd - git 仓库路径
 * @returns {string} `git log --since=today 00:00` 的格式化输出
 */
function gitLogToday(cwd) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const out = run(cwd, ['log', `--since=${today} 00:00`, '--pretty=%s%n%b%n---']);
  return out;
}

module.exports = { gitStatus, gitDiffStat, gitAdd, gitCommit, gitLogSubjects, gitLogToday };
