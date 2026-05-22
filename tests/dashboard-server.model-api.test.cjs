'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-model-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd, list: registryList } = require('../lib/registry.cjs');
const {
  createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS,
} = require('../lib/workbook.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

async function mkProject(rows = []) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks', 'run'), { recursive: true });
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  if (rows.length) {
    await withWorkbook(xlsx, async wb => {
      const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
      rows.forEach(r => ws.addRow(r));
    });
  }
  return proj;
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/projects/:slug/desired-model 合法模型成功返回 ok', async () => {
  const proj = await mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/desired-model`,
    { model: 'sonnet' },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.desiredModel, 'sonnet');

  const found = registryList().find(p => p.slug === entry.slug);
  assert.equal(found.desiredModel, 'sonnet');
});

test('POST /api/projects/:slug/desired-model 非法模型返回 400', async () => {
  const proj = await mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/desired-model`,
    { model: 'gpt' },
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /opus\/sonnet\/haiku/);
});

test('POST /api/projects/:slug/desired-model 空字符串返回 400', async () => {
  const proj = await mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/desired-model`,
    { model: '' },
  );
  assert.equal(res.status, 400);
});

test('POST /api/projects/:slug/desired-model 项目不存在返回 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/no-such/desired-model`,
    { model: 'opus' },
  );
  assert.equal(res.status, 404);
});

test('POST /api/projects/:slug/desired-model 非法 slug 格式返回 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/..%2Fevil/desired-model`,
    { model: 'opus' },
  );
  assert.equal(res.status, 400);
});

test('POST /api/projects/:slug/tasks/:id/model 写入合法模型成功', async () => {
  const proj = await mkProject([
    { id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/tasks/1/model`,
    { model: 'haiku' },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.task.model, 'haiku');

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 1).model, 'haiku');
});

test('POST /api/projects/:slug/tasks/:id/model 空字符串清除覆盖', async () => {
  const proj = await mkProject([
    { id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办', model: 'sonnet' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/tasks/1/model`,
    { model: '' },
  );
  assert.equal(res.status, 200);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 1).model, '');
});

test('POST /api/projects/:slug/tasks/:id/model 非法模型返回 400', async () => {
  const proj = await mkProject([
    { id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/tasks/1/model`,
    { model: 'gpt' },
  );
  assert.equal(res.status, 400);
});

test('POST /api/projects/:slug/tasks/:id/model 找不到 id 返回 400', async () => {
  const proj = await mkProject([]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/tasks/999/model`,
    { model: 'opus' },
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /未找到 id=999/);
});

test('POST /api/projects/:slug/tasks/:id/model 项目不存在返回 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });

  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/no-such/tasks/1/model`,
    { model: 'opus' },
  );
  assert.equal(res.status, 404);
});
