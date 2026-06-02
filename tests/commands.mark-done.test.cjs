// tests/commands.mark-done.test.cjs
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createBlankWorkbook, withWorkbook, readRows,
  SHEET_IN_PROGRESS, SHEET_ARCHIVED,
} = require('../lib/workbook.cjs');
const markDoneCmd = require('../commands/mark-done.cjs');
const { markDoneCore, buildManualDoneBlock } = markDoneCmd;
const { STATES } = require('../lib/states.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-mark-done-'));
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

test('mark-done 把 待review 任务搬到已完结表,状态置已完成,ftime 写入', async () => {
  const proj = await setupProject([
    {
      id: 1, desc: '登录联调', scope: 'web', priority: '高',
      status: STATES.REVIEW, note: '', question: '', risk: 'iOS 端没复测',
      ctime: '2026-05-20T10:00:00Z', ftime: '2026-05-21T11:00:00Z',
    },
  ]);

  await markDoneCore(proj, { id: 1, summary: '复测过了，没问题' });

  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg.length, 0, '进行中表应清空');

  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(arch.length, 1);
  const row = arch[0];
  assert.equal(String(row.id), '1');
  assert.equal(row.status, STATES.DONE);
  assert.ok(row.ftime, 'ftime 应被刷新');
  // note 顶部应有 [done ts] 块,含 fromStatus 提示 + 原 Risk + 说明
  assert.match(String(row.note), /^\[done \d{4}-\d{2}-\d{2}/);
  assert.match(String(row.note), /手动标记完成（来自待 review）/);
  assert.match(String(row.note), /原 Risk: iOS 端没复测/);
  assert.match(String(row.note), /说明: 复测过了，没问题/);
});

test('mark-done 把 阻塞 任务搬到已完结表,note 包含原 Q', async () => {
  const proj = await setupProject([
    {
      id: 2, desc: '埋点字段', scope: 'web', priority: '中',
      status: STATES.BLOCKED, note: '', question: '埋点字段名跟产品确认下',
      risk: '', ctime: '2026-05-22T09:00:00Z', ftime: '',
    },
  ]);

  const result = await markDoneCore(proj, { id: 2, summary: '已和产品口头确认' });
  assert.equal(result.fromStatus, STATES.BLOCKED);
  assert.equal(result.status, STATES.DONE);

  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  const row = arch.find(r => String(r.id) === '2');
  assert.ok(row);
  assert.equal(row.status, STATES.DONE);
  assert.match(String(row.note), /手动标记完成（来自阻塞）/);
  assert.match(String(row.note), /原 Q: 埋点字段名跟产品确认下/);
  assert.match(String(row.note), /说明: 已和产品口头确认/);
});

test('mark-done 原 note 保留(新 done 块加在顶部,用 --- 分隔)', async () => {
  const proj = await setupProject([
    {
      id: 3, desc: 'x', scope: 'web', priority: '中',
      status: STATES.REVIEW, note: '[张三 回复 LATEST 2026-05-22 10:00] 看下这个',
      question: '', risk: 'r', ctime: '', ftime: '',
    },
  ]);

  await markDoneCore(proj, { id: 3, summary: 'ok' });

  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  const note = String(arch[0].note);
  assert.match(note, /^\[done /);
  assert.ok(note.includes('\n---\n'), '新旧块用 --- 分隔');
  assert.ok(note.includes('[张三 回复 LATEST'), '原 note 保留');
});

test('mark-done 拒绝非 review/阻塞 状态', async () => {
  const proj = await setupProject([
    {
      id: 4, desc: 'x', scope: 'web', priority: '中',
      status: STATES.IN_PROGRESS, note: '', question: '', risk: '',
      ctime: '', ftime: '',
    },
  ]);
  await assert.rejects(
    () => markDoneCore(proj, { id: 4, summary: '随便' }),
    /仅适用于 待review\/阻塞/,
  );
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg[0].status, STATES.IN_PROGRESS, '状态不应被改');
});

test('mark-done 拒绝空 summary', async () => {
  const proj = await setupProject([
    {
      id: 5, desc: 'x', scope: 'web', priority: '中',
      status: STATES.REVIEW, note: '', question: '', risk: 'r',
      ctime: '', ftime: '',
    },
  ]);
  await assert.rejects(
    () => markDoneCore(proj, { id: 5, summary: '   ' }),
    /summary 参数/,
  );
});

test('mark-done id 不存在 → 抛错', async () => {
  const proj = await setupProject([]);
  await assert.rejects(
    () => markDoneCore(proj, { id: 999, summary: 'x' }),
    /未找到 id=999/,
  );
});

test('CLI mark-done 拒绝 --flag 当 summary', async () => {
  const proj = await setupProject([
    {
      id: 6, desc: 'x', scope: 'web', priority: '中',
      status: STATES.REVIEW, note: '', question: '', risk: 'r',
      ctime: '', ftime: '',
    },
  ]);
  await assert.rejects(
    () => markDoneCmd(proj, ['6', '--foo']),
    /不接受 --flag/,
  );
});

test('buildManualDoneBlock 渲染 review 来源（含 Risk）', () => {
  const out = buildManualDoneBlock({
    ts: '2026-05-28 14:30',
    fromStatus: STATES.REVIEW,
    risk: 'r1',
    question: '',
    summary: 's1',
  });
  assert.match(out, /^\[done 2026-05-28 14:30\]\n/);
  assert.ok(out.includes('手动标记完成（来自待 review）'));
  assert.ok(out.includes('原 Risk: r1'));
  assert.ok(out.includes('说明: s1'));
  assert.ok(!out.includes('原 Q:'), 'review 来源不应出现 Q');
});

test('buildManualDoneBlock 渲染 blocked 来源（含 Q）', () => {
  const out = buildManualDoneBlock({
    ts: '2026-05-28 14:30',
    fromStatus: STATES.BLOCKED,
    risk: '',
    question: 'q1',
    summary: 's2',
  });
  assert.ok(out.includes('手动标记完成（来自阻塞）'));
  assert.ok(out.includes('原 Q: q1'));
  assert.ok(out.includes('说明: s2'));
  assert.ok(!out.includes('原 Risk:'));
});
