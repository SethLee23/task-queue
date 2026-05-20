const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const nextCmd = require('../commands/next.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('task-queue-next-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('next 队列空输出 null', async () => {
  const proj = await setupProject([]);
  const out = await captureStdout(() => nextCmd(proj, []));
  assert.equal(out.trim(), 'null');
});

test('next 取最高优先级的待办', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '低', status: '待办', note: '', question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '' },
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '待办', note: '', question: '', risk: '', ctime: '2026-05-20T11:00:00Z', ftime: '' },
    { id: 3, desc: 'c', scope: 'web', priority: '中', status: '待办', note: '', question: '', risk: '', ctime: '2026-05-20T09:00:00Z', ftime: '' },
  ]);
  const out = await captureStdout(() => nextCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, 2);  // 注意：数字 2，不是字符串 '2'
});

test('next 同优先级按创建时间升序', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', question: '', risk: '', ctime: '2026-05-20T12:00:00Z', ftime: '' },
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '待办', note: '', question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '' },
  ]);
  const out = await captureStdout(() => nextCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, 2);  // 数字
});

test('next 跳过非待办状态', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '阻塞-等答疑', note: '', question: '?', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '' },
    { id: 2, desc: 'b', scope: 'web', priority: '中', status: '待办', note: '', question: '', risk: '', ctime: '2026-05-20T11:00:00Z', ftime: '' },
  ]);
  const out = await captureStdout(() => nextCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, 2);  // 数字
});
