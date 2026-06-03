'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTmpGitProjectFactory } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');

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
