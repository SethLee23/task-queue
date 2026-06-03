'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory } = require('./_helpers.cjs');
const doneCmd = require('../commands/done.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('done-clean-');
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

test('--expect-clean 且仓库干净 → 正常无 commit 归档', async () => {
  const proj = await setupProject([
    { id: 1, desc: '调研', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await doneCmd(proj, ['1', '调研结论:...', '--expect-clean']);
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(arch.length, 1);
  assert.equal(arch[0].status, '已完成');
});

test('--expect-clean 且 tracked 文件被改 → 还原 + 转 review,不 commit', async () => {
  const proj = await setupProject([
    { id: 2, desc: '调研', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  fs.writeFileSync(path.join(proj, 'README.md'), '# polluted\n');
  await doneCmd(proj, ['2', '结论', '--expect-clean']);
  assert.equal(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), '# test\n');
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: proj }).toString().trim();
  assert.equal(count, '1');
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.match(String(rows[0].risk), /non-code|不应改/);
});

test('--expect-clean 且有 untracked 新文件 → 不删文件但转 review 列出', async () => {
  const proj = await setupProject([
    { id: 3, desc: '调研', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  fs.writeFileSync(path.join(proj, 'leak.txt'), 'x');
  await doneCmd(proj, ['3', '结论', '--expect-clean']);
  assert.ok(fs.existsSync(path.join(proj, 'leak.txt')), 'untracked 不删,留给人看');
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.match(String(rows[0].risk), /leak\.txt/);
});
