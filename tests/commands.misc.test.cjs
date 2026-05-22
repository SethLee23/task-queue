'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createBlankWorkbook,
  withWorkbook,
  readRows,
  SHEET_IN_PROGRESS,
  SHEET_ARCHIVED,
} = require('../lib/workbook.cjs');
const statusCmd = require('../commands/status.cjs');
const sweepCmd = require('../commands/sweep.cjs');
const recoverCmd = require('../commands/recover.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-misc-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/**
 * 创建临时项目目录，初始化 xlsx 并写入指定行数据。
 * @param {object[]} rows
 * @returns {Promise<string>} 项目根目录
 */
async function setupProject(rows) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  await withWorkbook(xlsx, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    rows.forEach(r => ws.addRow(r));
  });
  return proj;
}

/**
 * 捕获 process.stdout.write 输出，返回拼接后的字符串。
 * @param {() => Promise<void>} fn
 * @returns {Promise<string>}
 */
function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(c); return true; };
  return Promise.resolve(fn()).finally(() => { process.stdout.write = orig; })
    .then(() => chunks.join(''));
}

test('status 计数对', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办',       note: '', question: '',  risk: '', ctime: '', ftime: '' },
    { id: 2, desc: 'b', scope: 'web', priority: '中', status: '待办',       note: '', question: '',  risk: '', ctime: '', ftime: '' },
    { id: 3, desc: 'c', scope: 'web', priority: '中', status: '阻塞-等答疑', note: '', question: '?', risk: '', ctime: '', ftime: '' },
  ]);
  const out = await capture(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.todo, 2);
  assert.equal(parsed.blocked, 1);
});

test('sweep 把 已完成/跳过 剪到已完结', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '已完成', note: '', question: '', risk: '', ctime: '', ftime: '2026-05-20T11:00:00Z' },
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '跳过',   note: '', question: '', risk: '', ctime: '', ftime: '' },
    { id: 3, desc: 'c', scope: 'web', priority: '高', status: '待办',   note: '', question: '', risk: '', ctime: '', ftime: '' },
  ]);
  await sweepCmd(proj, []);
  const inProg   = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 1);
  // readRows 保留数字类型，id 是数字 3（非字符串）
  assert.equal(inProg[0].id, 3);
  assert.equal(archived.length, 2);
});

test('sweep 清孤儿附件,保留被引用的', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '已完成', note: '看 .tasks/attachments/keep.png', question: '', risk: '', ctime: '', ftime: '2026-05-20T11:00:00Z' },
    { id: 2, desc: '待办 .tasks/attachments/used-in-desc.jpg', scope: 'web', priority: '高', status: '待办', note: '', question: '', risk: '', ctime: '', ftime: '' },
  ]);
  // 准备 4 个附件:2 个被引用 + 2 个孤儿
  const attachDir = path.join(proj, '.tasks', 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, 'keep.png'), 'keep');
  fs.writeFileSync(path.join(attachDir, 'used-in-desc.jpg'), 'used');
  fs.writeFileSync(path.join(attachDir, 'orphan1.png'), 'gone');
  fs.writeFileSync(path.join(attachDir, 'orphan2.gif'), 'gone');

  const out = await capture(() => sweepCmd(proj, []));
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.archived, 1);
  assert.equal(parsed.attachmentsDeleted, 2);

  const remaining = fs.readdirSync(attachDir).sort();
  assert.deepEqual(remaining, ['keep.png', 'used-in-desc.jpg']);
});

test('sweep attachments 目录不存在时不报错', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '已完成', note: '', question: '', risk: '', ctime: '', ftime: '2026-05-20T11:00:00Z' },
  ]);
  const out = await capture(() => sweepCmd(proj, []));
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.archived, 1);
  assert.equal(parsed.attachmentsDeleted, 0);
});

test('sweep 即便没有可归档行,仍 GC 孤儿附件', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'still todo', scope: 'web', priority: '高', status: '待办', note: '', question: '', risk: '', ctime: '', ftime: '' },
  ]);
  const attachDir = path.join(proj, '.tasks', 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, 'orphan.png'), 'gone');

  const out = await capture(() => sweepCmd(proj, []));
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.archived, 0);
  assert.equal(parsed.attachmentsDeleted, 1);
  assert.equal(fs.existsSync(path.join(attachDir, 'orphan.png')), false);
});

test('collectReferencedAttachments 识别多字段中的多个引用', () => {
  const { collectReferencedAttachments } = sweepCmd;
  const refs = collectReferencedAttachments([
    { desc: '看 .tasks/attachments/a.png 和 .tasks/attachments/b.jpg', note: '', risk: '', question: '' },
    { desc: '', note: '.tasks/attachments/c.webp', risk: '.tasks/attachments/d.gif', question: '' },
    { desc: '', note: '', risk: '', question: '.tasks/attachments/e.jpeg' },
    { desc: '', note: '不含附件路径', risk: '', question: '' },
  ]);
  assert.deepEqual([...refs].sort(), ['a.png', 'b.jpg', 'c.webp', 'd.gif', 'e.jpeg']);
});

test('recover 把进行中重置为待办', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '进行中', note: '原备注', question: '', risk: '', ctime: '', ftime: '' },
  ]);
  await recoverCmd(proj, []);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '待办');
  assert.match(rows[0].note, /上次中断已重排队/);
  assert.match(rows[0].note, /原备注/);
});
