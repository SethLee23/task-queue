'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTmpGitProjectFactory } = require('./_helpers.cjs');
const { createForTask, destroyForTask, listOrphans } = require('../lib/worktree.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('wt-create-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('createForTask 在 .tasks/worktrees/task-N 创建 worktree + 拉 task-N 分支', async () => {
  const proj = await setupProject([]);
  const { worktreePath, branch } = createForTask(proj, 7);
  assert.equal(worktreePath, path.join(proj, '.tasks', 'worktrees', 'task-7'));
  assert.equal(branch, 'task-7');
  const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }).toString().trim();
  assert.equal(head, 'task-7');
});

test('createForTask 从主仓库当前 HEAD 分支拉(不硬编码 main)', async () => {
  const proj = await setupProject([]);
  execFileSync('git', ['checkout', '-q', '-b', 'develop'], { cwd: proj });
  const { worktreePath } = createForTask(proj, 8);
  const wtSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath }).toString().trim();
  const devSha = execFileSync('git', ['rev-parse', 'develop'], { cwd: proj }).toString().trim();
  assert.equal(wtSha, devSha);
});

test('createForTask 给 worktree 建 node_modules symlink 指向主仓库', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 11);
  const nm = path.join(worktreePath, 'node_modules');
  assert.ok(fs.lstatSync(nm).isSymbolicLink(), 'node_modules 应为 symlink');
  assert.ok(fs.readlinkSync(nm).endsWith('node_modules'));
});

test('createForTask 重复同 id 抛错', async () => {
  const proj = await setupProject([]);
  createForTask(proj, 3);
  assert.throws(() => createForTask(proj, 3), /已存在|exists/i);
});

test('destroyForTask 删 worktree,默认保留分支;deleteBranch=true 删分支', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 21);
  destroyForTask(proj, 21);
  assert.ok(!fs.existsSync(worktreePath));
  let branches = execFileSync('git', ['branch'], { cwd: proj }).toString();
  assert.ok(branches.includes('task-21'), '默认应保留分支');
  createForTask(proj, 22);
  destroyForTask(proj, 22, { deleteBranch: true });
  branches = execFileSync('git', ['branch'], { cwd: proj }).toString();
  assert.ok(!branches.includes('task-22'), 'deleteBranch 应删分支');
});

test('destroyForTask force=true 删带未提交改动的 worktree;目标不存在时幂等不抛', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 23);
  fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'unstaged');
  destroyForTask(proj, 23, { force: true });
  assert.ok(!fs.existsSync(worktreePath));
  destroyForTask(proj, 999);  // 不抛
});

test('listOrphans 列出 task-N worktree + 分支是否已 merge 回 base', async () => {
  const proj = await setupProject([]);
  createForTask(proj, 100);
  const { worktreePath } = createForTask(proj, 101);
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-q', '-m', 'wip'], { cwd: worktreePath });
  execFileSync('git', ['merge', '--ff-only', 'task-101'], { cwd: proj });
  const byId = Object.fromEntries(listOrphans(proj).map(o => [o.taskId, o]));
  assert.equal(byId[100].branchMerged, true);
  assert.equal(byId[101].branchMerged, true);
});

test('listOrphans 未 merge 的分支 branchMerged=false;无 worktree 时空数组', async () => {
  const proj = await setupProject([]);
  assert.deepEqual(listOrphans(proj), []);
  const { worktreePath } = createForTask(proj, 102);
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'y');
  execFileSync('git', ['add', '.'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-q', '-m', 'wip'], { cwd: worktreePath });
  const byId = Object.fromEntries(listOrphans(proj).map(o => [o.taskId, o]));
  assert.equal(byId[102].branchMerged, false);
});
