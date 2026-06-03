'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-parallel-ids-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

/** Create a minimal project dir with heartbeat.json written directly (no xlsx needed). */
function mkProj(heartbeatData) {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  if (heartbeatData) {
    fs.writeFileSync(
      path.join(p, '.tasks', 'run', 'heartbeat.json'),
      JSON.stringify(heartbeatData),
    );
  }
  return p;
}

// ─── Case 1: new-schema heartbeat with currentTaskIds array ───────────────────

test('GET /api/projects/:slug 暴露 currentTaskIds (新 schema)', async () => {
  const proj = mkProj({
    phase: 'executing',
    currentTaskIds: [7, 9],
    currentTaskId: 7,
    currentTaskDesc: '#7 a ｜ #9 b',
    model: 'x',
    ts: new Date().toISOString(),
  });
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  assert.equal(res.status, 200);
  const body = await res.json();

  // project.currentTaskIds must be [7, 9]
  assert.ok(Array.isArray(body.project.currentTaskIds), 'currentTaskIds should be an array');
  assert.deepEqual(body.project.currentTaskIds, [7, 9]);
});

test('GET /api/projects/:slug currentTask 仍用 currentTaskId=7 (镜像兼容)', async () => {
  const proj = mkProj({
    phase: 'executing',
    currentTaskIds: [7, 9],
    currentTaskId: 7,
    currentTaskDesc: '#7 a ｜ #9 b',
    model: 'x',
    ts: new Date().toISOString(),
  });
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  const body = await res.json();

  // currentTask (single-task mirror) still works
  assert.equal(body.project.currentTask.id, 7);
});

// ─── Case 2: old-schema heartbeat (only currentTaskId, no currentTaskIds) ─────

test('GET /api/projects/:slug 旧 schema (无 currentTaskIds) → 升级为 [5]', async () => {
  const proj = mkProj({
    phase: 'executing',
    currentTaskId: 5,
    currentTaskDesc: 'old task',
    model: 'y',
    ts: new Date().toISOString(),
    // deliberately no currentTaskIds field
  });
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  assert.equal(res.status, 200);
  const body = await res.json();

  // readHeartbeat upgrades old schema: currentTaskIds should be [5]
  assert.ok(Array.isArray(body.project.currentTaskIds), 'currentTaskIds should be an array');
  assert.deepEqual(body.project.currentTaskIds, [5]);
});

// ─── Case 3: single-task path unchanged ───────────────────────────────────────

test('GET /api/projects/:slug 单任务 currentTaskIds=[3] 且 currentTask 填充正常', async () => {
  const proj = mkProj({
    phase: 'executing',
    currentTaskIds: [3],
    currentTaskId: 3,
    currentTaskDesc: 'single task',
    model: 'z',
    ts: new Date().toISOString(),
  });
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  const body = await res.json();

  assert.deepEqual(body.project.currentTaskIds, [3]);
  assert.equal(body.project.currentTask.id, 3);
  assert.equal(body.project.currentTask.desc, 'single task');
});
