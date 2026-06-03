'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const worktreeCreateCmd = require('../commands/worktree-create.cjs');
const worktreeListCmd = require('../commands/worktree-list.cjs');
const worktreeDiscardCmd = require('../commands/worktree-discard.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('wt-mgmt-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('worktree-create 建 worktree 输出 JSON;worktree-list 列出;worktree-discard 删', async () => {
  const proj = await setupProject([]);
  const c = JSON.parse(await captureStdout(() => worktreeCreateCmd(proj, ['7'])));
  assert.match(c.worktreePath, /task-7$/);
  assert.equal(c.branch, 'task-7');
  await captureStdout(() => worktreeCreateCmd(proj, ['9']));

  const l = JSON.parse(await captureStdout(() => worktreeListCmd(proj, [])));
  assert.deepEqual(l.worktrees.map(w => w.taskId).sort((a,b)=>a-b), [7, 9]);

  await captureStdout(() => worktreeDiscardCmd(proj, ['7']));
  assert.ok(!fs.existsSync(c.worktreePath));
  const l2 = JSON.parse(await captureStdout(() => worktreeListCmd(proj, [])));
  assert.deepEqual(l2.worktrees.map(w => w.taskId), [9]);
});

test('worktree-create / worktree-discard 缺 id 抛错', async () => {
  const proj = await setupProject([]);
  await assert.rejects(() => worktreeCreateCmd(proj, []), /id/);
  await assert.rejects(() => worktreeDiscardCmd(proj, []), /id/);
});
