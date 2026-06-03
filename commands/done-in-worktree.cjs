'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { worktreePathFor } = require('../lib/worktree.cjs');

const DEPS_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pom.xml'];

function changedFilesIn(wtPath) {
  const out = execFileSync('git', ['status', '--porcelain=v1'], { cwd: wtPath }).toString();
  return out.split('\n').filter(Boolean).map(line => {
    const filePath = line.slice(3).trim();
    const arrowIdx = filePath.indexOf(' -> ');
    return arrowIdx === -1 ? filePath : filePath.slice(arrowIdx + 4);
  }).filter(f => {
    // Skip symlinks that point to directories (e.g. shared node_modules symlink created by createForTask).
    // git --porcelain reports them as untracked when .gitignore uses a trailing-slash pattern,
    // but they are not real changes the worker produced.
    const abs = path.join(wtPath, f);
    try {
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink()) {
        const resolved = fs.realpathSync(abs);
        return !fs.statSync(resolved).isDirectory();
      }
    } catch (_) {}
    return true;
  });
}

/**
 * code worker 在 worktree 内调:把改动 WIP commit 到自己的 task-N 分支。
 * 不动 Excel、不动主仓库;改了依赖文件直接拒绝(并行模式禁 deps 变更)。
 * @param {string} projectRoot
 * @param {string[]} args args[0] = taskId
 */
module.exports = async function doneInWorktree(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('done-in-worktree 需要 id 参数');
  const wtPath = worktreePathFor(projectRoot, idArg);
  if (!fs.existsSync(wtPath)) throw new Error(`worktree 不存在:${wtPath}`);

  const changed = changedFilesIn(wtPath);
  if (changed.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, taskId: idArg, commitSha: null, changedFiles: [] }) + '\n');
    return;
  }

  const depsHit = changed.filter(f => DEPS_FILES.some(d => f === d || f.endsWith('/' + d)));
  if (depsHit.length > 0) {
    process.stdout.write(JSON.stringify({
      ok: false, taskId: idArg, reason: `并行模式禁止改依赖文件:${depsHit.join(', ')}`,
    }) + '\n');
    return;
  }

  execFileSync('git', ['add', '--', ...changed], { cwd: wtPath });
  execFileSync('git', ['commit', '-q', '-m', `WIP task #${idArg}`], { cwd: wtPath });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath }).toString().trim();
  process.stdout.write(JSON.stringify({ ok: true, taskId: idArg, commitSha: sha, changedFiles: changed }) + '\n');
};
