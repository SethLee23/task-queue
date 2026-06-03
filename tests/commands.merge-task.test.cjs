'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const doneInWorktreeCmd = require('../commands/done-in-worktree.cjs');
const mergeTaskCmd = require('../commands/merge-task.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('merge-task-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeParallelCfg(proj) {
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true' },
      versionFiles: { web: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md' },
      inferModule: () => 'web',
      commitMessage: ({ desc, version }) => 'web: ' + desc + ' v' + version,
      parallel: { enabled: true, maxConcurrency: 3, allowSameScope: true },
    };
  `);
}

async function setupReadyForMerge(id = 1) {
  const proj = await setupProject([{
    id, desc: 'feat', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '',
  }]);
  writeParallelCfg(proj);
  const { worktreePath } = createForTask(proj, id);
  fs.writeFileSync(path.join(worktreePath, 'feat.txt'), 'hello');
  await captureStdout(() => doneInWorktreeCmd(proj, [String(id)]));
  return { proj, worktreePath };
}

test('ff-merge 成功:main 有正式 commit(含版本号),worktree+分支清除,任务归档', async () => {
  const { proj, worktreePath } = await setupReadyForMerge();
  const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['1', '加了 feat.txt'])));
  assert.equal(j.ok, true);
  const log = execFileSync('git', ['log', '--oneline'], { cwd: proj }).toString();
  assert.match(log, /web: feat v0\.0\.2/);
  assert.ok(!log.includes('WIP task'), 'WIP commit 应被正式 commit 取代');
  assert.ok(!fs.existsSync(worktreePath));
  const branches = execFileSync('git', ['branch'], { cwd: proj }).toString();
  assert.ok(!branches.includes('task-1'));
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(arch[0].status, '已完成');
  assert.match(String(arch[0].note), /加了 feat\.txt/);
});

test('main 已前进但无冲突 → rebase 后 merge 成功', async () => {
  const { proj } = await setupReadyForMerge(2);
  fs.writeFileSync(path.join(proj, 'other.txt'), 'main moved');
  execFileSync('git', ['add', 'other.txt'], { cwd: proj });
  execFileSync('git', ['commit', '-q', '-m', 'main forward'], { cwd: proj });
  const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['2', 's'])));
  assert.equal(j.ok, true);
});

test('rebase 冲突 → 转 review,worktree 保留,summary 保全进 note', async () => {
  const { proj, worktreePath } = await setupReadyForMerge(3);
  fs.writeFileSync(path.join(proj, 'feat.txt'), 'MAIN VERSION');
  execFileSync('git', ['add', 'feat.txt'], { cwd: proj });
  execFileSync('git', ['commit', '-q', '-m', 'main override'], { cwd: proj });
  const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['3', '做完了但撞了'])));
  assert.equal(j.ok, false);
  assert.match(j.reason, /冲突/);
  assert.ok(fs.existsSync(worktreePath), 'worktree 保留给人工');
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.match(String(rows[0].risk), /worktrees\/task-3/);
  assert.match(String(rows[0].note), /做完了但撞了/);
});

test('summary 缺失 → 转 review(与 done 同语义)', async () => {
  const { proj } = await setupReadyForMerge(4);
  const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['4'])));
  assert.equal(j.ok, false);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
});
