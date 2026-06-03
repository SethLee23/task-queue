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

/**
 * 删除任务 worktree,可选删分支。幂等(目标不存在不抛)。
 */
function destroyForTask(projectRoot, taskId, opts = {}) {
  const wtPath = worktreePathFor(projectRoot, taskId);
  const branch = branchFor(taskId);
  if (fs.existsSync(wtPath)) {
    const args = ['worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push(wtPath);
    try {
      execFileSync('git', args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) {
      fs.rmSync(wtPath, { recursive: true, force: true });
      try { execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot }); } catch (_) {}
    }
  }
  if (opts.deleteBranch) {
    try {
      execFileSync('git', ['branch', '-D', branch], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) { /* 分支不存在,忽略 */ }
  }
}

/**
 * 列出 .tasks/worktrees 下所有 task-N 目录及分支 merge 状态。
 * @returns {Array<{taskId:number, worktreePath:string, branch:string, branchMerged:boolean}>}
 */
function listOrphans(projectRoot, baseBranch) {
  const root = worktreeRoot(projectRoot);
  if (!fs.existsSync(root)) return [];
  const base = baseBranch || defaultBranch(projectRoot);
  const entries = fs.readdirSync(root)
    .map(name => {
      const m = name.match(/^task-(\d+)$/);
      return m ? { name, taskId: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean);
  let mergedBranches = new Set();
  try {
    const out = execFileSync('git', ['branch', '--merged', base], {
      cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    mergedBranches = new Set(out.split('\n').map(s => s.replace(/^[*+]?\s*/, '').trim()).filter(Boolean));
  } catch (_) {}
  return entries.map(e => ({
    taskId: e.taskId,
    worktreePath: path.join(root, e.name),
    branch: branchFor(e.taskId),
    branchMerged: mergedBranches.has(branchFor(e.taskId)),
  }));
}

module.exports = {
  createForTask, destroyForTask, listOrphans,
  worktreePathFor, branchFor, worktreeRoot, defaultBranch,
};
