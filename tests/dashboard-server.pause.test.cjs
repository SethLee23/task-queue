'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd, list: listReg } = require('../lib/registry.cjs');
const { readPaused } = require('../lib/paused.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-pause-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  await createBlankWorkbook(path.join(p, '.tasks', 'tasks.xlsx'));
  return p;
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

test('POST pause 写 loop-paused 含 reason', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/pause`,
    { reason: '面板手动暂停' },
  );
  assert.equal(res.status, 200);
  assert.equal(readPaused(proj), '面板手动暂停');
});

test('POST resume 删 loop-paused', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/pause`, { reason: 'x' });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/resume`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(readPaused(proj), null);
});

test('DELETE /api/projects/:slug 移出注册表', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(listReg().find(p => p.slug === entry.slug), undefined);
  assert.equal(fs.existsSync(proj), true, '.tasks 目录不应被删');
});
