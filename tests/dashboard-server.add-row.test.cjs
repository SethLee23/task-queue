'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-addrow-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { createBlankWorkbook, readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

async function mkProject(opts = {}) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'), { recursive: true });
  if (opts.config !== false) {
    fs.writeFileSync(
      path.join(proj, '.tasks', 'project.config.js'),
      `module.exports = {
        scopes: { web: { dir: 'web', autoCommit: true }, core: { dir: '.', autoCommit: false } },
        buildCommands: { web: 'true', core: 'true' },
        versionFiles: { web: 'web/package.json', core: 'package.json' },
        changelogFiles: { web: 'web/README.md', core: 'CHANGELOG.md' },
        sameDayShareVersion: true,
        inferModule: () => '路由管理',
        commitMessage: ({ scope, module, desc, version }) =>
          \`T#0000 \${scope}## \${version}\\n\\n【\${module}】\${desc}；\`,
        autoPush: false,
      };`,
    );
  }
  await createBlankWorkbook(path.join(proj, '.tasks', 'tasks.xlsx'));
  return proj;
}

test('GET /api/projects/:slug 返回 scopes 列表', async () => {
  const proj = await mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  const body = await res.json();
  assert.deepEqual(body.scopes.sort(), ['core', 'web']);
});

test('GET /api/projects/:slug 配置缺失时 scopes 为空数组', async () => {
  const proj = await mkProject({ config: false });
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  const body = await res.json();
  assert.deepEqual(body.scopes, []);
});

test('POST /api/projects/:slug/add-row 写入待办行并返回 id', async () => {
  const proj = await mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/add-row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desc: '修登录按钮', scope: 'web', priority: '高', note: '紧急' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.row.id, 1);
  assert.equal(body.row.scope, 'web');

  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].desc, '修登录按钮');
  assert.equal(rows[0].priority, '高');
  assert.equal(rows[0].note, '紧急');
});

test('POST /api/projects/:slug/add-row 多次追加 id 自增', async () => {
  const proj = await mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/add-row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desc: 'a', scope: 'web' }),
  });
  const res2 = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/add-row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desc: 'b', scope: 'core' }),
  });
  const body2 = await res2.json();
  assert.equal(body2.row.id, 2);
});

test('POST /api/projects/:slug/add-row desc 缺失 → 400', async () => {
  const proj = await mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/add-row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'web' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/projects/:slug/add-row scope 不在 config → 400 + 错误信息', async () => {
  const proj = await mkProject();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/add-row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desc: 'x', scope: 'invalid' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /invalid/);
});

test('POST /api/projects/:slug/add-row 项目不存在 → 404', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/no-such/add-row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desc: 'x', scope: 'web' }),
  });
  assert.equal(res.status, 404);
});
