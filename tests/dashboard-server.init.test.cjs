'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-init-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

async function srv() {
  if (!inst) inst = await startServer({ port: 0 });
  return `http://127.0.0.1:${inst.port}`;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('POST /api/init/detect attach: 返回 detect 结果与状态位', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'det-'));
  execFileSync('git', ['init', '-q'], { cwd: proj });
  fs.writeFileSync(path.join(proj, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.2.3', scripts: { build: 'true' } }));

  const r = await post(`${await srv()}/api/init/detect`, { root: proj, mode: 'attach' });
  assert.equal(r.status, 200);
  assert.equal(r.body.root, fs.realpathSync.native(proj));
  assert.equal(r.body.isGitRepo, true);
  assert.equal(r.body.alreadyInitialized, false);
  assert.equal(r.body.detect.packages[0].version, '1.2.3');
});

test('POST /api/init/detect attach: 已接入项目报 alreadyInitialized', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'det-inited-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  fs.writeFileSync(path.join(proj, '.tasks', 'project.config.js'), 'module.exports = {};\n');

  const r = await post(`${await srv()}/api/init/detect`, { root: proj, mode: 'attach' });
  assert.equal(r.status, 200);
  assert.equal(r.body.alreadyInitialized, true);
});

test('POST /api/init/detect attach: 目录不存在 → 400', async () => {
  const r = await post(`${await srv()}/api/init/detect`,
    { root: path.join(tmpDir, 'ghost'), mode: 'attach' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /不存在/);
});

test('POST /api/init/detect create: 目标不存在时返回空 detect', async () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'det-create-'));
  const r = await post(`${await srv()}/api/init/detect`,
    { root: path.join(parent, 'newp'), mode: 'create' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.detect.packages, []);
  assert.equal(r.body.isGitRepo, false);
});

test('POST /api/init/detect create: 目标已存在 → 400', async () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'det-exists-'));
  const r = await post(`${await srv()}/api/init/detect`, { root: parent, mode: 'create' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /已存在/);
});

test('POST /api/init/detect: 缺 root 或非法 mode → 400', async () => {
  const r1 = await post(`${await srv()}/api/init/detect`, { mode: 'attach' });
  assert.equal(r1.status, 400);
  const r2 = await post(`${await srv()}/api/init/detect`, { root: '/tmp/x', mode: 'bogus' });
  assert.equal(r2.status, 400);
});
