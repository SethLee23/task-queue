'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-getfile-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

function mkProjectWithAttach() {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks', 'attachments'), { recursive: true });
  const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(proj, '.tasks', 'attachments', 'tiny.png'), buf);
  fs.writeFileSync(path.join(proj, 'secret.txt'), 'TOP SECRET');
  return proj;
}

test('GET /file 正常返回 attachment 图片', async () => {
  const proj = mkProjectWithAttach();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/file?path=${encodeURIComponent('.tasks/attachments/tiny.png')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0);
});

test('GET /file path 非 .tasks/attachments/ 开头 → 403', async () => {
  const proj = mkProjectWithAttach();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/file?path=${encodeURIComponent('secret.txt')}`);
  assert.equal(res.status, 403);
});

test('GET /file .. 路径逃逸 → 403', async () => {
  const proj = mkProjectWithAttach();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/file?path=${encodeURIComponent('.tasks/attachments/../../secret.txt')}`);
  assert.equal(res.status, 403);
});

test('GET /file 不支持的扩展名 → 415', async () => {
  const proj = mkProjectWithAttach();
  fs.writeFileSync(path.join(proj, '.tasks', 'attachments', 'evil.html'), '<script>');
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/file?path=${encodeURIComponent('.tasks/attachments/evil.html')}`);
  assert.equal(res.status, 415);
});

test('GET /file 文件不存在 → 404', async () => {
  const proj = mkProjectWithAttach();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/file?path=${encodeURIComponent('.tasks/attachments/missing.png')}`);
  assert.equal(res.status, 404);
});

test('GET /file 缺 path 参数 → 400', async () => {
  const proj = mkProjectWithAttach();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/file`);
  assert.equal(res.status, 400);
});

test('GET /file slug 不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/no-such/file?path=${encodeURIComponent('.tasks/attachments/x.png')}`);
  assert.equal(res.status, 404);
});

test('GET /file slug 非法 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/BAD_SLUG/file?path=${encodeURIComponent('.tasks/attachments/x.png')}`);
  assert.equal(res.status, 400);
});

test('GET /file 返回 Cache-Control 头', async () => {
  const proj = mkProjectWithAttach();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/file?path=${encodeURIComponent('.tasks/attachments/tiny.png')}`);
  assert.match(res.headers.get('cache-control') || '', /max-age=\d+/);
});
