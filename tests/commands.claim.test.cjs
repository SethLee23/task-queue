const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const claimCmd = require('../commands/claim.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-claim-'));
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

test('claim 把状态从待办改为进行中', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '' },
  ]);
  await claimCmd(proj, ['1']);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '进行中');
});

test('claim 当 id 为空时回填为现有最大 id + 1', async () => {
  const proj = await setupProject([
    { id: 5, desc: 'old', scope: 'web', priority: '高', status: '已完成-待review', note: '', question: '', risk: 'x', ctime: '', ftime: '' },
    { id: '',  desc: '新任务', scope: 'web', priority: '中', status: '待办', note: '', question: '', risk: '', ctime: '', ftime: '' },
  ]);
  await claimCmd(proj, ['auto']);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const claimed = rows.find(r => r.status === '进行中');
  assert.ok(claimed, '有一行被 claim');
  assert.equal(claimed.id, 6);  // 数字
  assert.equal(claimed.desc, '新任务');
});

test('claim 不存在的 id 抛错', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', question: '', risk: '', ctime: '', ftime: '' },
  ]);
  await assert.rejects(() => claimCmd(proj, ['999']), /未找到.*999/);
});

test('claim 非待办状态抛错', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '已完成-待review', note: '', question: '', risk: 'x', ctime: '', ftime: '' },
  ]);
  await assert.rejects(() => claimCmd(proj, ['1']), /非法转换|状态/);
});
