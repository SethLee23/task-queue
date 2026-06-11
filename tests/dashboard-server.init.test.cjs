'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

/**
 * 使用 http.request 发送请求，允许自定义 Host 头（fetch/undici 会忽略 Host 覆盖）。
 * @param {string} urlStr 目标 URL
 * @param {{ method?: string, headers?: object, body?: string }} opts
 * @returns {Promise<{ status: number }>}
 */
function rawRequest(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const reqHeaders = { ...headers };
    if (body && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method, headers: reqHeaders },
      res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

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

// ─── Part A: 服务器防护 ───────────────────────────────────────────────────────
// Node.js fetch (undici) 把 Host 列为禁止修改的 forbidden header，
// 实测覆盖被静默忽略（返回真实 host），所以改用 http.request 原生方式设置 Host。

test('安全防护: 非本机 Host → 403', async () => {
  const base = await srv();
  const res = await rawRequest(`${base}/api/projects`, {
    headers: { Host: 'evil.example.com' },
  });
  assert.equal(res.status, 403);
});

test('安全防护: POST /api/* 带非 JSON Content-Type → 415', async () => {
  const base = await srv();
  const body = JSON.stringify({ root: '/tmp/x', mode: 'attach' });
  const res = await rawRequest(`${base}/api/init/detect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': Buffer.byteLength(body),
      Host: `127.0.0.1:${new URL(base).port}`,
    },
    body,
  });
  assert.equal(res.status, 415);
});

test('安全防护: 无 Content-Type 的 POST /api/* → 415', async () => {
  // 空 CT 与无 CT 均不得绕过防护（防跨站 simple-request 盲打，Blob type='' 场景）
  const base = await srv();
  const res = await rawRequest(`${base}/api/projects/no-such-slug/resume`, {
    method: 'POST',
    headers: { Host: `127.0.0.1:${new URL(base).port}` },
  });
  assert.equal(res.status, 415);
});

test('安全防护: 带 body 无 Content-Type 的 POST /api/* → 415', async () => {
  // 攻击者通过 fetch(Blob, {type:''}) 携带任意 body 但不设 CT，同样应被拦截
  const base = await srv();
  const body = JSON.stringify({ root: '/tmp/x', mode: 'attach' });
  const res = await rawRequest(`${base}/api/init/detect`, {
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${new URL(base).port}`,
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  assert.equal(res.status, 415);
});

// ─── Part B: POST /api/init ───────────────────────────────────────────────────

/**
 * 生成最小合法 answers 对象。
 * @param {string} scope scope 名称
 */
function makeAnswers(scope = 'main') {
  return {
    autoCommitScopes: [],
    scopeMapping: { [scope]: { dir: '.', versionFile: 'package.json', changelogFile: '', buildCommand: '' } },
    candidateModules: { [scope]: ['全局'] },
    commitTemplate: { [scope]: `T#0000 ${scope}## {version}\n\n【{module}】{desc}；` },
    sameDayShareVersion: true,
  };
}

test('POST /api/init attach: 全链路落盘+注册+commit,项目出现在 /api/projects', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'init-attach-'));
  execFileSync('git', ['init', '-q'], { cwd: proj });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: proj });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: proj });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: proj });

  const r = await post(`${await srv()}/api/init`,
    { mode: 'attach', root: proj, answers: makeAnswers() });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.committed, true);
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'tasks.xlsx')));

  const list = await fetch(`${await srv()}/api/projects`).then(x => x.json());
  assert.ok(list.projects.some(p => p.slug === r.body.slug));
});

test('POST /api/init create: 脚手架全链路', async () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'init-create-'));
  const root = path.join(parent, 'newborn');
  const r = await post(`${await srv()}/api/init`,
    { mode: 'create', root, answers: makeAnswers() });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(root, 'package.json')));
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'project.config.js')));
});

test('POST /api/init register: 仅注册不动配置', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'init-reg-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  fs.writeFileSync(path.join(proj, '.tasks', 'project.config.js'), 'module.exports = { marker: 7 };\n');

  const r = await post(`${await srv()}/api/init`, { mode: 'register', root: proj });
  assert.equal(r.status, 200);
  assert.ok(r.body.slug);
  assert.match(fs.readFileSync(path.join(proj, '.tasks', 'project.config.js'), 'utf8'), /marker: 7/);
});

test('POST /api/init: answers 缺失或不完整 → 400', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'init-bad-'));
  const r1 = await post(`${await srv()}/api/init`, { mode: 'attach', root: proj });
  assert.equal(r1.status, 400);
  const r2 = await post(`${await srv()}/api/init`,
    { mode: 'attach', root: proj, answers: { scopeMapping: {} } });
  assert.equal(r2.status, 400);
});

test('POST /api/init: 路径越界 → 400', async () => {
  const r = await post(`${await srv()}/api/init`,
    { mode: 'attach', root: '/', answers: makeAnswers() });
  assert.equal(r.status, 400);
});
