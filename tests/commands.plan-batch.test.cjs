'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const planBatchCmd = require('../commands/plan-batch.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('plan-batch-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeParallelCfg(proj, parallel = { enabled: true, maxConcurrency: 3, allowSameScope: true }) {
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true }, service: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true', service: 'true' },
      versionFiles: { web: 'package.json', service: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md', service: 'CHANGELOG.md' },
      inferModule: (_, s) => s,
      commitMessage: ({ scope, desc, version }) => scope + ': ' + desc + ' v' + version,
      parallel: ${JSON.stringify(parallel)},
    };
  `);
}

const ROWS = [
  { id: 7, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', model: 'sonnet', ctime: '2026-01-01T00:00:00Z' },
  { id: 8, desc: 'b', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
  { id: 9, desc: 'c', scope: 'service', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:02:00Z' },
];

test('plan-batch 默认 limit=5,输出候选(含 model) + scopeMutex + 配置', async () => {
  const proj = await setupProject(ROWS);
  writeParallelCfg(proj);
  const j = JSON.parse(await captureStdout(() => planBatchCmd(proj, [])));
  assert.equal(j.candidates.length, 3);
  assert.equal(j.candidates[0].model, 'sonnet');
  assert.ok(j.scopeMutex.some(p => p.includes(7) && p.includes(8)));
  assert.ok(!j.scopeMutex.some(p => p.includes(7) && p.includes(9)));
  assert.equal(j.maxConcurrency, 3);
  assert.equal(j.allowSameScope, true);
});

test('plan-batch --limit 2 截断,按优先级+ctime 排序', async () => {
  const proj = await setupProject(ROWS);
  writeParallelCfg(proj);
  const j = JSON.parse(await captureStdout(() => planBatchCmd(proj, ['--limit', '2'])));
  assert.deepEqual(j.candidates.map(c => c.id), [7, 8]);
});

test('parallel.enabled=false 时返回空 + reason 提示走串行', async () => {
  const proj = await setupProject(ROWS);
  writeParallelCfg(proj, { enabled: false });
  const j = JSON.parse(await captureStdout(() => planBatchCmd(proj, [])));
  assert.deepEqual(j.candidates, []);
  assert.match(j.reason || '', /未启用|串行/);
});
