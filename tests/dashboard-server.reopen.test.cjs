// tests/dashboard-server.reopen.test.cjs
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reopen-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');

let inst;
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

// mkProject(archivedRows): create a project whose archived sheet has the given rows.
async function mkProject(archivedRows) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'), { recursive: true });
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  if (archivedRows.length > 0) {
    await withWorkbook(xlsx, async wb => {
      const ws = wb.getWorksheet(SHEET_ARCHIVED);
      archivedRows.forEach(r => ws.addRow(r));
    });
  }
  return proj;
}

function doneRow(over = {}) {
  return { id: 5, desc: 'x', scope: 'web', priority: '中', status: STATES.DONE,
    note: '[done] ok', question: '', risk: '', ctime: '2026-06-01T00:00:00.000Z',
    ftime: '2026-06-02T00:00:00.000Z', model: '', tags: '', checklist: '', ...over };
}

test('POST /reopen 正常 → 200 且任务进 TODO', async () => {
  const proj = await mkProject([doneRow()]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 5, reply: '继续做' }),
  });
  assert.equal(r.status, 200);
  const inp = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inp.find(x => String(x.id) === '5').status, STATES.TODO);
});
test('POST /reopen reply 空 → 400', async () => {
  const proj = await mkProject([doneRow()]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 5, reply: '  ' }),
  });
  assert.equal(r.status, 400);
});
test('POST /reopen id 不存在 → 4xx', async () => {
  const proj = await mkProject([doneRow()]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 999, reply: 'x' }),
  });
  assert.ok(r.status >= 400 && r.status < 500, `应 4xx，实际 ${r.status}`);
});
test('POST /reopen slug 非法 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/Bad_Slug/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 5, reply: 'x' }),
  });
  assert.equal(r.status, 400);
});
test('GET /history 也返回 SKIPPED 任务', async () => {
  const proj = await mkProject([doneRow({ id: 8, status: STATES.SKIPPED })]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/history?days=365`);
  const body = await r.json();
  assert.ok(body.items.some(it => String(it.id) === '8' && it.status === STATES.SKIPPED),
    'history 应含 skipped 项且带 status');
});
