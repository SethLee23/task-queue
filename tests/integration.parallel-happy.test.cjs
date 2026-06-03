'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const claimBatchCmd = require('../commands/claim-batch.cjs');
const worktreeCreateCmd = require('../commands/worktree-create.cjs');
const mergeTaskCmd = require('../commands/merge-task.cjs');
const doneCmd = require('../commands/done.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('integ-happy-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('e2e: claim-batch → 2 code worker(子进程)+ 1 non-code → merge ×2 + expect-clean done → 全归档', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'web 改', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:00:00Z' },
    { id: 2, desc: 'svc 改', scope: 'service', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
    { id: 3, desc: '调研 X 是什么', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:02:00Z' },
  ]);
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true }, service: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true', service: 'true' },
      versionFiles: { web: 'package.json', service: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md', service: 'CHANGELOG.md' },
      inferModule: (_, s) => s,
      commitMessage: ({ scope, desc, version }) => scope + ': ' + desc + ' v' + version,
      parallel: { enabled: true, maxConcurrency: 3, allowSameScope: true },
    };
  `);

  await captureStdout(() => claimBatchCmd(proj, ['1', '2', '3']));
  await captureStdout(() => worktreeCreateCmd(proj, ['1']));
  await captureStdout(() => worktreeCreateCmd(proj, ['2']));

  // simulate code workers: edit file in each worktree + done-in-worktree (subprocess = real CLI path)
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-1', 'web.txt'), 'web work');
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-2', 'svc.txt'), 'svc work');
  for (const id of ['1', '2']) {
    const r = spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done-in-worktree', proj, id], { encoding: 'utf8' });
    assert.equal(r.status, 0, `done-in-worktree #${id}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).ok, true);
  }

  // simulate non-code worker: write report into .tasks/ (does NOT dirty the repo) → main loop expect-clean archive
  fs.mkdirSync(path.join(proj, '.tasks', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.tasks', 'reports', 'task-3.md'), '# 调研报告\n...');
  await doneCmd(proj, ['3', 'X 是...(摘要),全文见 .tasks/reports/task-3.md', '--expect-clean']);

  // main loop serial merge
  for (const id of ['1', '2']) {
    const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, [id, `任务${id}完成`])));
    assert.equal(j.ok, true, `merge-task #${id}: ${j.reason || ''}`);
  }

  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 0);
  assert.equal(arch.length, 3);
  assert.ok(!fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
  assert.ok(!fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-2')));
  const log = execFileSync('git', ['log', '--oneline'], { cwd: proj }).toString();
  assert.match(log, /web:/);
  assert.match(log, /service:/);
  assert.ok(!log.includes('调研'), 'non-code 任务不产生 commit');
  const hb = JSON.parse(fs.readFileSync(path.join(proj, '.tasks', 'run', 'heartbeat.json'), 'utf8'));
  assert.deepEqual(hb.currentTaskIds, []);
});
