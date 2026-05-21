'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { readWakeNow } = require('../lib/wake.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-wake-test-'));
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

test('POST wake-now 写 wake-now 文件含 reason', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/wake-now`,
    { reason: '紧急扫一下' },
  );
  assert.equal(res.status, 200);
  assert.equal(readWakeNow(proj), '紧急扫一下');
});

test('POST wake-now body 为空 → reason 默认 "面板立即执行"', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/wake-now`,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(readWakeNow(proj), '面板立即执行');
});

test('POST wake-now slug 非法 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/Bad%20Slug/wake-now`,
    {},
  );
  assert.equal(res.status, 400);
});

test('POST wake-now 项目不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/no-such-proj/wake-now`,
    {},
  );
  assert.equal(res.status, 404);
});

test('GET /api/projects 聚合包含 wakeNow / wakeNowReason 字段', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  // 先点一次 wake-now
  await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/wake-now`, { reason: 'x' });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  const found = body.projects.find(p => p.slug === entry.slug);
  assert.equal(found.wakeNow, true);
  assert.equal(found.wakeNowReason, 'x');
});
