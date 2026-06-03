'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const recoverCmd = require('../commands/recover.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('rec-orphan-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('崩溃恢复:进行中+worktree → 先重排队再转 review,worktree 保留', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  createForTask(proj, 1);
  await captureStdout(() => recoverCmd(proj, []));
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
});

test('review 状态的 orphan 不动(预期保留)', async () => {
  const proj = await setupProject([
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '已完成-待review', note: '', risk: 'x', ctime: '' },
  ]);
  createForTask(proj, 2);
  await captureStdout(() => recoverCmd(proj, []));
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-2')));
});

test('任务已不在进行中 sheet 且分支已 merge → 清 worktree+分支', async () => {
  const { execFileSync } = require('node:child_process');
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 3);
  fs.writeFileSync(path.join(worktreePath, 'x.txt'), 'x');
  execFileSync('git', ['add', '--', 'x.txt'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-q', '-m', 'wip'], { cwd: worktreePath });
  execFileSync('git', ['merge', '--ff-only', 'task-3'], { cwd: proj });
  await captureStdout(() => recoverCmd(proj, []));
  assert.ok(!fs.existsSync(worktreePath));
});

test('无 stuck 且无 orphan:输出 recovered=0,不抛', async () => {
  const proj = await setupProject([
    { id: 5, desc: 'e', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  const out = JSON.parse(await captureStdout(() => recoverCmd(proj, [])));
  assert.equal(out.recovered, 0);
});
