'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-proj-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
const { setPaused } = require('../lib/paused.cjs');
const { createBlankWorkbook, withWorkbook, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProjWithRow(rows) {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  const xlsx = path.join(p, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  if (rows.length > 0) {
    await withWorkbook(xlsx, async wb => {
      rows.forEach(r => wb.getWorksheet(SHEET_IN_PROGRESS).addRow(r));
    });
  }
  return p;
}

test('GET /api/projects 空注册表返回空数组', async () => {
  inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  assert.deepEqual(body, { projects: [] });
});

test('GET /api/projects 含注册项目，counts 正确', async () => {
  const proj = await mkProjWithRow([
    { id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办' },
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '进行中' },
    { id: 3, desc: 'c', scope: 'web', priority: '中', status: '阻塞-等答疑' },
  ]);
  registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  assert.equal(body.projects.length, 1);
  const p = body.projects[0];
  assert.equal(p.root, proj);
  assert.equal(p.counts.todo, 1);
  assert.equal(p.counts.in_progress, 1);
  assert.equal(p.counts.blocked, 1);
});

test('GET /api/projects 心跳为 executing 时 currentTask 填充', async () => {
  const proj = await mkProjWithRow([
    { id: 5, desc: 'in progress task', scope: 'web', priority: '高', status: '进行中' },
  ]);
  registryAdd(proj);
  writeHeartbeat(proj, { phase: 'executing', currentTaskId: 5, currentTaskDesc: 'in progress task' });
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  const p = body.projects[0];
  assert.equal(p.phase, 'executing');
  assert.equal(p.currentTask.id, 5);
  assert.equal(p.currentTask.desc, 'in progress task');
});

test('GET /api/projects 项目目录失联 → online=missing', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'gone-'));
  registryAdd(proj);
  fs.rmSync(proj, { recursive: true });
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  const p = body.projects.find(x => x.root === proj);
  assert.equal(p.online, 'missing');
});

test('GET /api/projects paused 标志反映 paused=true', async () => {
  const proj = await mkProjWithRow([]);
  registryAdd(proj);
  setPaused(proj, '面板暂停了');
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  const p = body.projects.find(x => x.root === proj);
  assert.equal(p.paused, true);
  assert.equal(p.pauseReason, '面板暂停了');
});
