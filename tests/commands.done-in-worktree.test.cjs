'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const doneInWorktreeCmd = require('../commands/done-in-worktree.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('diw-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('无改动 → ok:true commitSha:null,Excel 不动', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  createForTask(proj, 1);
  const j = JSON.parse(await captureStdout(() => doneInWorktreeCmd(proj, ['1'])));
  assert.equal(j.ok, true);
  assert.equal(j.commitSha, null);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '进行中', 'Excel 由主进程管,worker 命令不动');
});

test('有改动 → commit 到 task-N 分支,main 不受影响', async () => {
  const proj = await setupProject([
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  const { worktreePath } = createForTask(proj, 2);
  fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello');
  const j = JSON.parse(await captureStdout(() => doneInWorktreeCmd(proj, ['2'])));
  assert.equal(j.ok, true);
  assert.match(j.commitSha, /^[0-9a-f]{7,40}$/);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: worktreePath }).toString();
  assert.ok(tree.includes('feature.txt'), 'feature.txt 应在 commit 里');
  assert.ok(!tree.split('\n').includes('node_modules'), 'node_modules symlink 不能进 commit');
  const mainCount = execFileSync('git', ['rev-list', '--count', 'main'], { cwd: proj }).toString().trim();
  assert.equal(mainCount, '1', 'main 只有 init commit');
});

test('改了 package.json → 拒绝 commit,ok:false', async () => {
  const proj = await setupProject([
    { id: 3, desc: 'c', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  const { worktreePath } = createForTask(proj, 3);
  fs.writeFileSync(path.join(worktreePath, 'package.json'),
    JSON.stringify({ name: 'test', version: '0.0.2' }, null, 2) + '\n');
  const j = JSON.parse(await captureStdout(() => doneInWorktreeCmd(proj, ['3'])));
  assert.equal(j.ok, false);
  assert.match(j.reason, /依赖|package\.json/);
});

test('worktree 不存在 → 抛错', async () => {
  const proj = await setupProject([
    { id: 4, desc: 'd', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  await assert.rejects(() => doneInWorktreeCmd(proj, ['4']), /worktree.*不存在/);
});
