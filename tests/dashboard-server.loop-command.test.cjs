'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-loopcmd-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');

let inst;
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

test('GET /api/projects/:slug/loop-command 返回完整命令 + 替换好 ${PROJECT_ROOT}', async () => {
  const proj = mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/loop-command`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.command, 'string');
  assert.equal(body.projectRoot, proj);

  // 必须以 cd 开头并包含 claude '/loop
  assert.ok(body.command.startsWith(`cd '`), '应当以 cd ' + "'" + ' 开头');
  assert.ok(body.command.includes(` && claude '/loop `), '应当包含 && claude /loop 段');

  // PROJECT_ROOT 占位符必须已经被替换
  assert.ok(!body.command.includes('${PROJECT_ROOT}'), 'PROJECT_ROOT 应被替换');

  // 项目路径应在命令中（单引号包裹）
  assert.ok(body.command.includes(`'${proj}'`), '项目路径应单引号出现在命令中');
});

test("GET /loop-command 项目路径含单引号时正确转义", async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, "weird-'-proj-"));
  fs.mkdirSync(path.join(proj, '.tasks'), { recursive: true });
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/loop-command`);
  assert.equal(res.status, 200);
  const body = await res.json();
  // POSIX 单引号转义后字面 ' 形如 '\'' （右单引号 + 转义 + 左单引号）
  assert.ok(body.command.includes("'\\''"), '路径里的单引号应转义为 ' + "'\\''");
});

test('GET /loop-command slug 非法 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/Bad_Slug/loop-command`);
  assert.equal(res.status, 400);
});

test('GET /loop-command 项目不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/no-such/loop-command`);
  assert.equal(res.status, 404);
});
