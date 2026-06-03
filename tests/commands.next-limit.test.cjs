'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const nextCmd = require('../commands/next.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('next-limit-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const ROWS = [
  { id: 1, desc: 'a', scope: 'w', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:00:00Z' },
  { id: 2, desc: 'b', scope: 'w', priority: '中', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
  { id: 3, desc: 'c', scope: 's', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:02:00Z' },
];

test('next --limit 3 返回数组,按优先级+ctime 排序', async () => {
  const proj = await setupProject(ROWS);
  const j = JSON.parse(await captureStdout(() => nextCmd(proj, ['--limit', '3'])));
  assert.ok(Array.isArray(j));
  assert.deepEqual(j.map(r => r.id), [1, 3, 2]);
});

test('next --limit 空队列输出 []', async () => {
  const proj = await setupProject([]);
  const out = await captureStdout(() => nextCmd(proj, ['--limit', '3']));
  assert.equal(out.trim(), '[]');
});

test('next 不带 --limit 仍返回单 obj(向后兼容)', async () => {
  const proj = await setupProject(ROWS);
  const j = JSON.parse(await captureStdout(() => nextCmd(proj, [])));
  assert.ok(!Array.isArray(j));
  assert.equal(j.id, 1);
});
