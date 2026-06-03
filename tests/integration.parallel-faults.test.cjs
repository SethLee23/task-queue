'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const claimBatchCmd = require('../commands/claim-batch.cjs');
const worktreeCreateCmd = require('../commands/worktree-create.cjs');
const mergeTaskCmd = require('../commands/merge-task.cjs');
const requeueCmd = require('../commands/requeue.cjs');
const reviewCmd = require('../commands/review.cjs');
const recoverCmd = require('../commands/recover.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('integ-faults-');
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

function diw(proj, id) { // run done-in-worktree as subprocess (simulate worker)
  const r = spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done-in-worktree', proj, String(id)], { encoding: 'utf8' });
  return r;
}

// ── Test (a) ─────────────────────────────────────────────────────────────────
// Two workers both edit shared.txt; first merge succeeds (ff), second
// hits a rebase conflict → converted to review, worktree kept.
test('故障(a) 两 worker 改同文件 → 第二条 merge 冲突转 review,worktree 保留', async () => {
  const proj = await setupProject([
    { id: 1, desc: 't1', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 't2', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1', '2']));
  await captureStdout(() => worktreeCreateCmd(proj, ['1']));
  await captureStdout(() => worktreeCreateCmd(proj, ['2']));
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-1', 'shared.txt'), 'v1');
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-2', 'shared.txt'), 'v2');
  diw(proj, 1); diw(proj, 2);
  const j1 = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['1', 's1'])));
  assert.equal(j1.ok, true);
  const j2 = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['2', 's2'])));
  assert.equal(j2.ok, false);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => String(r.id) === '2').status, '已完成-待review');
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-2')));
});

// ── Test (b) ─────────────────────────────────────────────────────────────────
// Human resolves the conflict and merge-task retry succeeds.
//
// Simulation strategy: after a conflict, the human discards the conflicting
// commit using `git reset --hard <base>`, then creates a NEW commit that
// writes a different file (task1-fix.txt) so there is zero chance of replay
// conflict during rebase. This is the most reliable approach because:
//   - amend would replay the same patch → rebase still conflicts
//   - reset --hard + fresh commit produces a 1-commit-ahead branch with no overlap
// We also set status back to IN_PROGRESS (simulating a human "reopen" action)
// so merge-task's IN_PROGRESS guard passes.
test('故障(b) 解决冲突后 merge-task 重试成功(人工回路)', async () => {
  const proj = await setupProject([
    { id: 1, desc: 't1', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  await captureStdout(() => worktreeCreateCmd(proj, ['1']));
  const wt = path.join(proj, '.tasks', 'worktrees', 'task-1');

  // Worker writes shared.txt to the worktree branch
  fs.writeFileSync(path.join(wt, 'shared.txt'), 'worktree version');
  diw(proj, 1);

  // Base branch advances with a conflicting edit to the same file
  fs.writeFileSync(path.join(proj, 'shared.txt'), 'BASE VERSION');
  execFileSync('git', ['add', 'shared.txt'], { cwd: proj });
  execFileSync('git', ['commit', '-q', '-m', 'base adds shared.txt'], { cwd: proj });

  // First merge attempt: should fail (conflict) → task becomes REVIEW
  const j1 = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['1', 's'])));
  assert.equal(j1.ok, false, 'expected conflict → ok:false');

  // Human resolves: reset worktree branch to base, then make a fresh non-conflicting commit.
  // Using reset --hard so we drop the old conflicting WIP and start clean.
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proj }).toString().trim();
  execFileSync('git', ['reset', '--hard', baseSha], { cwd: wt });
  // Write a new file (no overlap with shared.txt) so rebase has nothing to replay conflict
  fs.writeFileSync(path.join(wt, 'task1-fix.txt'), 'human resolved');
  execFileSync('git', ['add', 'task1-fix.txt'], { cwd: wt });
  execFileSync('git', ['commit', '-q', '-m', 'task-1 resolved'], { cwd: wt });

  // Human reopens: set status back to IN_PROGRESS so merge-task guard passes
  await withWorkbook(path.join(proj, '.tasks', 'tasks.xlsx'), async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    ws.eachRow((row, rowNum) => {
      if (rowNum > 1 && String(row.getCell(colIndex('id')).value) === '1') {
        row.getCell(colIndex('status')).value = STATES.IN_PROGRESS;
        row.commit();
      }
    });
  });

  // Retry: should succeed now
  const j2 = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['1', 's retry'])));
  assert.equal(j2.ok, true, j2.reason || '');
});

// ── Test (c) ─────────────────────────────────────────────────────────────────
// A non-code worker dirties a tracked file (README.md). done --expect-clean
// must restore the file via git checkout and convert the task to review.
test('故障(c) non-code 弄脏仓库 → done --expect-clean 还原 + review', async () => {
  const proj = await setupProject([
    { id: 1, desc: '调研', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  fs.writeFileSync(path.join(proj, 'README.md'), '# polluted\n');
  const r = spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done', proj, '1', '结论', '--expect-clean'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), '# test\n');
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
});

// ── Test (d) ─────────────────────────────────────────────────────────────────
// requeue once (needs-code round-trip), then on second claim+review → review.
// This verifies that a task can be reclaimed after needs-code, and that
// a second escalation via review() puts it in REVIEW state.
test('故障(d) needs-code 一次回流成功,二次转 review', async () => {
  const proj = await setupProject([
    { id: 1, desc: '看看要不要改', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  await captureStdout(() => requeueCmd(proj, ['1', '要改 LoginPage']));
  let rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '待办');
  assert.match(String(rows[0].note), /\[needs-code/);
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  await captureStdout(() => reviewCmd(proj, ['1', '二次 needs-code,请人工拆解']));
  rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
});

// ── Test (e) ─────────────────────────────────────────────────────────────────
// Simulates a crash after claim+worktree-create. recover() must:
//   - notice the IN_PROGRESS task now has an orphan worktree → transition to REVIEW
//   - keep the worktree directory (for human inspection)
test('故障(e) claim 后 recover → 任务转 review,worktree 保留', async () => {
  const proj = await setupProject([
    { id: 1, desc: 't', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  await captureStdout(() => worktreeCreateCmd(proj, ['1']));
  await captureStdout(() => recoverCmd(proj, []));
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
});
