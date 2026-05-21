'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { createBlankWorkbook, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-detail-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProj(inRows, archRows = []) {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  const xlsx = path.join(p, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  await withWorkbook(xlsx, async wb => {
    inRows.forEach(r => wb.getWorksheet(SHEET_IN_PROGRESS).addRow(r));
    archRows.forEach(r => wb.getWorksheet(SHEET_ARCHIVED).addRow(r));
  });
  return p;
}

test('GET /api/projects/:slug 不存在 → 404', async () => {
  inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/no-such-slug`);
  assert.equal(res.status, 404);
});

test('GET /api/projects/:slug 返回分组任务列表', async () => {
  const todayIso = new Date().toISOString();
  const proj = await mkProj(
    [
      { id: 1, desc: 't1', scope: 'web', priority: '中', status: '待办', ctime: todayIso },
      { id: 2, desc: 't2', scope: 'web', priority: '高', status: '进行中', ctime: todayIso },
      { id: 3, desc: 't3', scope: 'web', priority: '低', status: '已完成-待review', risk: 'r1', ctime: todayIso },
      { id: 4, desc: 't4', scope: 'web', priority: '中', status: '阻塞-等答疑', question: 'q1', ctime: todayIso },
    ],
    [
      { id: 99, desc: 't99', scope: 'web', priority: '中', status: '已完成', ftime: todayIso },
    ],
  );
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  const body = await res.json();
  assert.equal(body.project.slug, entry.slug);
  assert.equal(body.tasks.todo.length, 1);
  assert.equal(body.tasks.in_progress.length, 1);
  assert.equal(body.tasks.review.length, 1);
  assert.equal(body.tasks.blocked.length, 1);
  assert.equal(body.tasks.done_today.length, 1);
  assert.equal(body.tasks.review[0].risk, 'r1');
  assert.equal(body.tasks.blocked[0].question, 'q1');
});

test('GET /api/projects/:slug 非法 slug 格式 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/Bad!Slug`);
  assert.equal(res.status, 400);
});
