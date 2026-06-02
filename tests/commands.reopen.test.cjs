'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { reopenCore } = require('../commands/reopen.cjs');
const { createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');

process.env.TASK_QUEUE_USER_NAME = '测试者';

async function mkProject(archivedRows, inProgressRows = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-'));
  fs.mkdirSync(path.join(root, '.tasks'), { recursive: true });
  const xlsx = path.join(root, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  await withWorkbook(xlsx, async wb => {
    if (inProgressRows.length > 0) {
      const wsIn = wb.getWorksheet(SHEET_IN_PROGRESS);
      inProgressRows.forEach(r => wsIn.addRow(r));
    }
    if (archivedRows.length > 0) {
      const wsArch = wb.getWorksheet(SHEET_ARCHIVED);
      archivedRows.forEach(r => wsArch.addRow(r));
    }
  });
  return { root, xlsx };
}

function doneRow(over = {}) {
  return {
    id: 42, desc: '修复登录', scope: 'web', priority: '中', status: STATES.DONE,
    note: '[done 2026-06-01 10:00]\ncommit abc123\n说明: 修好了', question: '', risk: '',
    ctime: '2026-06-01T00:00:00.000Z', ftime: '2026-06-01T02:00:00.000Z', model: '', tags: '', checklist: '',
    ...over,
  };
}

test('DONE 任务重开 → 搬到进行中、status=TODO、ftime 清空、id 不变', async () => {
  const { root, xlsx } = await mkProject([doneRow()]);
  const r = await reopenCore(root, { id: 42, reply: '还要支持记住密码' });
  assert.equal(r.id, 42);
  assert.equal(r.status, STATES.TODO);
  assert.equal(r.fromStatus, STATES.DONE);
  assert.equal(r.reopened, true);
  const arch = await readRows(xlsx, SHEET_ARCHIVED);
  assert.equal(arch.find(x => String(x.id) === '42'), undefined, '归档表不应再有 42');
  const inp = await readRows(xlsx, SHEET_IN_PROGRESS);
  const moved = inp.find(x => String(x.id) === '42');
  assert.ok(moved, '进行中表应有 42');
  assert.equal(moved.status, STATES.TODO);
  assert.ok(!moved.ftime, 'ftime 应清空');
});

test('SKIPPED 任务重开 → 同样成功', async () => {
  const { root, xlsx } = await mkProject([doneRow({ id: 7, status: STATES.SKIPPED, note: '跳过原因' })]);
  const r = await reopenCore(root, { id: 7, reply: '其实还是要做' });
  assert.equal(r.status, STATES.TODO);
  assert.equal(r.fromStatus, STATES.SKIPPED);
  const inp = await readRows(xlsx, SHEET_IN_PROGRESS);
  assert.ok(inp.find(x => String(x.id) === '7'));
});

test('note：旧 LATEST 降级、新块为唯一 LATEST、原 done 块保留', async () => {
  const prev = '[张三 回复 LATEST 2026-06-01 09:00] 老回复\n---\n[done 2026-06-01 10:00]\n说明: ok';
  const { root, xlsx } = await mkProject([doneRow({ note: prev })]);
  await reopenCore(root, { id: 42, reply: '新指令' });
  const inp = await readRows(xlsx, SHEET_IN_PROGRESS);
  const note = inp.find(x => String(x.id) === '42').note;
  assert.equal((note.match(/回复 LATEST/g) || []).length, 1, '只应有 1 个 LATEST');
  assert.ok(note.includes('回复 OBSOLETE'), '旧 LATEST 应降级 OBSOLETE');
  assert.ok(note.includes('新指令'));
  assert.ok(note.includes('[done 2026-06-01 10:00]'), '原 done 块应保留');
  assert.ok(note.indexOf('新指令') < note.indexOf('[done'), '新块在顶部');
  assert.ok(note.includes('[测试者 回复 LATEST'), '新块应含回复人名');
});

test('reply 为空 → 抛错', async () => {
  const { root } = await mkProject([doneRow()]);
  await assert.rejects(() => reopenCore(root, { id: 42, reply: '   ' }), /回复内容不能为空|reply/);
});

test('id 不在归档表 → 抛错', async () => {
  const { root } = await mkProject([doneRow()]);
  await assert.rejects(() => reopenCore(root, { id: 999, reply: 'x' }), /未找到/);
});

test('归档表里状态非 DONE/SKIPPED → 抛错', async () => {
  const { root } = await mkProject([doneRow({ status: STATES.TODO })]);
  await assert.rejects(() => reopenCore(root, { id: 42, reply: 'x' }), /仅适用|DONE|SKIPPED|状态/);
});
