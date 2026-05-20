const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createBlankWorkbook, withWorkbook, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const nextCmd = require('../commands/next.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-next-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function setupProject(rows) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  if (rows.length > 0) {
    await withWorkbook(xlsx, async wb => {
      const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
      rows.forEach(r => ws.addRow(r));
    });
  }
  return proj;
}

function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = origWrite;
  }).then(() => chunks.join(''));
}

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
