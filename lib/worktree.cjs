'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function worktreeRoot(projectRoot) {
  return path.join(projectRoot, '.tasks', 'worktrees');
}

function worktreePathFor(projectRoot, taskId) {
  return path.join(worktreeRoot(projectRoot), `task-${taskId}`);
}

function branchFor(taskId) {
  return `task-${taskId}`;
}

/**
 * 主仓库当前 HEAD 分支名(并行的 base 分支,不硬编码 main)。
 */
function defaultBranch(projectRoot) {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

/**
 * 创建任务专属 worktree,从 base 分支拉 task-N 分支,node_modules symlink 共享主仓库。
 * @param {string} projectRoot
 * @param {number|string} taskId
 * @param {string} [baseBranch] 缺省 = 主仓库当前 HEAD 分支
 * @returns {{worktreePath:string, branch:string, baseBranch:string}}
 */
function createForTask(projectRoot, taskId, baseBranch) {
  const base = baseBranch || defaultBranch(projectRoot);
  const wtPath = worktreePathFor(projectRoot, taskId);
  const branch = branchFor(taskId);
  if (fs.existsSync(wtPath)) {
    throw new Error(`worktree 已存在: ${wtPath}`);
  }
  fs.mkdirSync(worktreeRoot(projectRoot), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, wtPath, base], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srcNm = path.join(projectRoot, 'node_modules');
  if (fs.existsSync(srcNm)) {
    const dstNm = path.join(wtPath, 'node_modules');
    if (fs.existsSync(dstNm)) fs.rmSync(dstNm, { recursive: true, force: true });
    fs.symlinkSync(path.relative(wtPath, srcNm), dstNm, 'dir');
  }
  return { worktreePath: wtPath, branch, baseBranch: base };
}

module.exports = { createForTask, worktreePathFor, branchFor, worktreeRoot, defaultBranch };
