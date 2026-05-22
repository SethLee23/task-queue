'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { setTaskModelCore } = require('../commands/set-task-model.cjs');
const {
  createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS,
} = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-task-model-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function mkProjWithRows(rows) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks', 'run'), { recursive: true });
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  await withWorkbook(xlsx, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    rows.forEach(r => ws.addRow(r));
  });
  return proj;
}

test('setTaskModelCore 写入合法模型到 model 列', async () => {
  const proj = await mkProjWithRows([
    { id: 1, desc: 't1', scope: 'web', priority: '中', status: '待办' },
  ]);
  const res = await setTaskModelCore(proj, { id: 1, model: 'haiku' });
  assert.equal(res.id, 1);
  assert.equal(res.model, 'haiku');

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 1).model, 'haiku');
});

test('setTaskModelCore 空字符串清除覆盖（回退项目级）', async () => {
  const proj = await mkProjWithRows([
    { id: 2, desc: 't2', scope: 'web', priority: '高', status: '待办', model: 'sonnet' },
  ]);
  const res = await setTaskModelCore(proj, { id: 2, model: '' });
  assert.equal(res.model, '');

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 2).model, '');
});

test('setTaskModelCore 非法模型抛错且不持久化', async () => {
  const proj = await mkProjWithRows([
    { id: 3, desc: 't3', scope: 'web', priority: '中', status: '待办', model: 'sonnet' },
  ]);
  await assert.rejects(
    () => setTaskModelCore(proj, { id: 3, model: 'gpt' }),
    /不支持的模型/,
  );
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 3).model, 'sonnet'); // 未变化
});

test('setTaskModelCore 找不到 id 抛错', async () => {
  const proj = await mkProjWithRows([
    { id: 4, desc: 't4', scope: 'web', priority: '中', status: '待办' },
  ]);
  await assert.rejects(
    () => setTaskModelCore(proj, { id: 999, model: 'opus' }),
    /未找到 id=999/,
  );
});

test('setTaskModelCore 缺 id 参数抛错', async () => {
  const proj = await mkProjWithRows([]);
  await assert.rejects(
    () => setTaskModelCore(proj, { id: '', model: 'opus' }),
    /需要 id 参数/,
  );
});

test('setTaskModelCore 三种合法模型 opus/sonnet/haiku 都能写入', async () => {
  const proj = await mkProjWithRows([
    { id: 10, desc: 'a', scope: 'web', priority: '中', status: '待办' },
    { id: 11, desc: 'b', scope: 'web', priority: '中', status: '待办' },
    { id: 12, desc: 'c', scope: 'web', priority: '中', status: '待办' },
  ]);
  await setTaskModelCore(proj, { id: 10, model: 'opus' });
  await setTaskModelCore(proj, { id: 11, model: 'sonnet' });
  await setTaskModelCore(proj, { id: 12, model: 'haiku' });
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 10).model, 'opus');
  assert.equal(rows.find(r => r.id === 11).model, 'sonnet');
  assert.equal(rows.find(r => r.id === 12).model, 'haiku');
});

test('setTaskModelCore 写入后多次读出仍然保留 model 值（无丢失）', async () => {
  const proj = await mkProjWithRows([
    { id: 20, desc: 'persist', scope: 'web', priority: '中', status: '待办' },
  ]);
  await setTaskModelCore(proj, { id: 20, model: 'sonnet' });
  // 再写一次（不改 model）确认前一次 model 不会被覆盖
  await setTaskModelCore(proj, { id: 20, model: 'sonnet' });
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 20).model, 'sonnet');
});
