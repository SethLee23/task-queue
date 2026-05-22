'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-upimg-test-'));
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

function mkProject() {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'), { recursive: true });
  return proj;
}

// 1x1 透明 png（base64）
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('POST /upload-image 成功写入并返回相对路径', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: TINY_PNG_B64 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.path, /^\.tasks\/attachments\/[\w.\-:]+\.png$/);
  assert.ok(body.bytes > 0);

  const absPath = path.join(proj, body.path);
  assert.ok(fs.existsSync(absPath), '写入的图片文件应存在');
  assert.equal(fs.statSync(absPath).size, body.bytes);
});

test('POST /upload-image 首次成功后 .gitignore 含 .tasks/attachments/', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const giPath = path.join(proj, '.gitignore');
  fs.writeFileSync(giPath, 'node_modules/\n');

  await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: TINY_PNG_B64 }),
  });

  const gi = fs.readFileSync(giPath, 'utf8');
  assert.match(gi, /\.tasks\/attachments\//);
  assert.match(gi, /node_modules\//, '原有内容保留');
});

test('POST /upload-image 重复上传 .gitignore 不重复追加', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const giPath = path.join(proj, '.gitignore');
  fs.writeFileSync(giPath, '.tasks/attachments/\n');

  await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: TINY_PNG_B64 }),
  });

  const gi = fs.readFileSync(giPath, 'utf8');
  const occurrences = (gi.match(/\.tasks\/attachments\//g) || []).length;
  assert.equal(occurrences, 1);
});

test('POST /upload-image 不存在的 .gitignore 会被创建', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const giPath = path.join(proj, '.gitignore');
  assert.ok(!fs.existsSync(giPath));

  await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: TINY_PNG_B64 }),
  });

  assert.ok(fs.existsSync(giPath));
  assert.match(fs.readFileSync(giPath, 'utf8'), /\.tasks\/attachments\//);
});

test('POST /upload-image 不支持的 contentType → 400', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/bmp', dataBase64: TINY_PNG_B64 }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /不支持/);
});

test('POST /upload-image 缺失 contentType → 400', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataBase64: TINY_PNG_B64 }),
  });
  assert.equal(res.status, 400);
});

test('POST /upload-image 缺失 dataBase64 → 400', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /dataBase64/);
});

test('POST /upload-image 空 dataBase64 → 400', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: '' }),
  });
  assert.equal(res.status, 400);
});

test('POST /upload-image 图片解码后 > 5MB → 413', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  // 6MB 原始字节，base64 后 ~8MB（超过 body cap 7MB），会被 body 层 abort 返回 413
  const big = Buffer.alloc(6 * 1024 * 1024, 0xaa).toString('base64');
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: big }),
  });
  assert.equal(res.status, 413);
});

test('POST /upload-image 解码后正好 > 5MB 但 body 仍在 cap 内 → 413（应用层 check）', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  // 5MB + 100 字节 raw → base64 ~6.7MB（< 7MB body cap，但 > 5MB image cap）
  const justOver = Buffer.alloc(5 * 1024 * 1024 + 100, 0xab).toString('base64');
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: justOver }),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.match(body.error, /图片过大|payload too large/);
});

test('POST /upload-image slug 非法 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/INVALID_SLUG/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: TINY_PNG_B64 }),
  });
  assert.equal(res.status, 400);
});

test('POST /upload-image 项目不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/no-such-proj/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: TINY_PNG_B64 }),
  });
  assert.equal(res.status, 404);
});

test('POST /upload-image 多张图片各自独立文件', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const r1 = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: TINY_PNG_B64 }),
  });
  const r2 = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/jpeg', dataBase64: TINY_PNG_B64 }),
  });
  const b1 = await r1.json();
  const b2 = await r2.json();
  assert.notEqual(b1.path, b2.path);
  assert.ok(b1.path.endsWith('.png'));
  assert.ok(b2.path.endsWith('.jpg'));
});
