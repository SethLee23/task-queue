/**
 * git 操作封装模块
 *
 * 所有命令失败时直接抛错（不吞），方便上层感知。
 * 内部 run() 仅供本模块使用，不 export。
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { localDateStr } = require('./datetime.cjs');

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
 *
 * 重命名条目（R 状态，格式 `R  old -> new`）会自动解析为新路径；
 * 普通新增/修改/删除条目正常返回路径字符串。
 * @param {string} cwd - git 仓库路径
 * @returns {string[]} 改动文件的相对路径数组，干净时返回空数组
 */
function gitStatus(cwd) {
  const out = run(cwd, ['status', '--porcelain=v1']);
  return out
    .split('\n')
    .filter(Boolean)
    // porcelain=v1 每行前 2 字符是 XY 状态码 + 1 空格，path 从第 4 字节开始
    .map(line => {
      const filePath = line.slice(3).trim();
      // 重命名条目格式：`R<status>  old -> new`，只保留新路径
      const arrowIdx = filePath.indexOf(' -> ');
      return arrowIdx === -1 ? filePath : filePath.slice(arrowIdx + 4);
    });
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
 * 初始化 git 仓库（`git init -q`），已是仓库时 git 自身幂等。
 * @param {string} cwd - 目标目录
 */
function gitInitRepo(cwd) {
  run(cwd, ['init', '-q']);
}

/**
 * 创建只包含指定 pathspec 的 commit（`git commit --only -m msg -- files`），
 * 不会带上暂存区里其它文件的改动。
 *
 * 提交的是这些路径的工作区当前内容（--only 语义）；gitAdd 仅为让未追踪文件被 git 识别。
 * @param {string} cwd - git 仓库路径
 * @param {string} message - commit 信息
 * @param {string[]} files - 要提交的文件路径列表（不能为空）
 * @throws {Error} files 为空数组时抛错（空 pathspec 会让 git 提交整个暂存区，违反函数语义）
 * @throws {Error} git commit 失败时抛错（含 "nothing to commit" 等情况）
 */
function gitCommitPaths(cwd, message, files) {
  if (!files.length) throw new Error('gitCommitPaths: files 不能为空');
  run(cwd, ['commit', '-m', message, '--', ...files]);
}

/**
 * 获取 HEAD 的 short hash（7 位）。
 * @param {string} cwd - git 仓库路径
 * @returns {string} short hash
 */
function gitRevParseHead(cwd) {
  return run(cwd, ['rev-parse', '--short', 'HEAD']).trim();
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
  const today = localDateStr();
  const out = run(cwd, ['log', `--since=${today} 00:00`, '--pretty=%s%n%b%n---']);
  return out;
}

module.exports = { gitStatus, gitDiffStat, gitAdd, gitCommit, gitInitRepo, gitCommitPaths, gitRevParseHead, gitLogSubjects, gitLogToday };
