const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadProjectConfig } = require('../lib/config.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-cfg-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function setupProject(configContent) {
  const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(projDir, '.tasks'));
  fs.writeFileSync(path.join(projDir, '.tasks', 'project.config.js'), configContent);
  return projDir;
}

test('loadProjectConfig 加载完整 config 成功', () => {
  const proj = setupProject(`module.exports = {
    scopes: { web: { dir: 'web', autoCommit: true } },
    buildCommands: { web: 'npm run build' },
    versionFiles: { web: 'web/package.json' },
    changelogFiles: { web: 'web/README.md' },
    sameDayShareVersion: true,
    inferModule: () => '路由管理',
    commitMessage: ({ scope, module, desc, version }) =>
      \`T#0000 \${scope}## \${version}\\n\\n【\${module}】\${desc}；\`,
    autoPush: false,
  };`);
  const cfg = loadProjectConfig(proj);
  assert.equal(cfg.scopes.web.autoCommit, true);
  assert.equal(cfg.sameDayShareVersion, true);
  assert.equal(typeof cfg.inferModule, 'function');
});

test('loadProjectConfig 缺 .tasks/project.config.js 抛错', () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-empty-'));
  assert.throws(() => loadProjectConfig(proj), /project\.config\.js 不存在/);
});

test('loadProjectConfig 缺必备字段 scopes 抛错', () => {
  const proj = setupProject('module.exports = { buildCommands: {} };');
  assert.throws(() => loadProjectConfig(proj), /缺少字段 scopes/);
});

test('loadProjectConfig 缺 commitMessage 抛错', () => {
  const proj = setupProject(`module.exports = {
    scopes: { web: { dir: 'web', autoCommit: true } },
    buildCommands: { web: 'x' },
    versionFiles: { web: 'x' },
    changelogFiles: { web: 'x' },
    inferModule: () => 'x',
  };`);
  assert.throws(() => loadProjectConfig(proj), /缺少字段 commitMessage/);
});
