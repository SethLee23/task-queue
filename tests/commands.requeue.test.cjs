'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const requeueCmd = require('../commands/requeue.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('requeue-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('requeue 把进行中任务转回待办,note 顶部加 [needs-code] 标记', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '进行中', note: '旧备注', ctime: '' },
  ]);
  const j = JSON.parse(await captureStdout(() => requeueCmd(proj, ['1', '其实要改 LoginPage.tsx'])));
  assert.equal(j.ok, true);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '待办');
  assert.match(String(rows[0].note), /^\[needs-code .*\] 其实要改 LoginPage\.tsx/);
  assert.match(String(rows[0].note), /旧备注/);
});

test('requeue 非进行中任务 → 抛错', async () => {
  const proj = await setupProject([
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  await assert.rejects(() => requeueCmd(proj, ['2', 'x']), /非法转换/);
});

test('reason 以 -- 开头 → 拒绝(防 flag 误传)', async () => {
  const proj = await setupProject([
    { id: 3, desc: 'c', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  await assert.rejects(() => requeueCmd(proj, ['3', '--summary']), /flag|--/);
});
