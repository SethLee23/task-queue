'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const claimBatchCmd = require('../commands/claim-batch.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('claim-batch-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('claim-batch 把多条 id 同步标进行中,输出 claimed 列表', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'b', scope: 'svc', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  const j = JSON.parse(await captureStdout(() => claimBatchCmd(proj, ['1', '2'])));
  assert.equal(j.claimed.length, 2);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 1).status, '进行中');
  assert.equal(rows.find(r => r.id === 2).status, '进行中');
});

test('claim-batch 某条非待办 → 抛错且整批不落盘', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'b', scope: 'svc', priority: '高', status: '已完成-待review', note: '', risk: 'x', ctime: '' },
  ]);
  await assert.rejects(() => claimBatchCmd(proj, ['1', '2']), /非法转换/);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 1).status, '待办');
});

test('claim-batch 写 heartbeat currentTaskIds + 聚合 desc', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'aaa', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'bbb', scope: 'svc', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  await captureStdout(() => claimBatchCmd(proj, ['1', '2']));
  const hb = JSON.parse(fs.readFileSync(path.join(proj, '.tasks', 'run', 'heartbeat.json'), 'utf8'));
  assert.deepEqual([...hb.currentTaskIds].sort(), [1, 2]);
  assert.equal(hb.phase, 'executing');
  assert.match(hb.currentTaskDesc, /#1.*aaa/);
  assert.match(hb.currentTaskDesc, /#2.*bbb/);
});
