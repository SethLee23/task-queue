const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadProjectConfig, getIdleSleepSeconds, getMaxRounds } = require('../lib/config.cjs');

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

test('getIdleSleepSeconds 缺字段 → 默认 270', () => {
  assert.equal(getIdleSleepSeconds({}), 270);
});

test('getIdleSleepSeconds null/undefined → 默认 270', () => {
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: null }), 270);
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: undefined }), 270);
});

test('getIdleSleepSeconds 非数字 → 默认 270', () => {
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: 'abc' }), 270);
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: NaN }), 270);
});

test('getIdleSleepSeconds 合法数字 → 透传 + 取整', () => {
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: 600 }), 600);
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: 270.7 }), 271);
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: '900' }), 900);
});

test('getIdleSleepSeconds 越界 → clamp 到 [60, 3600]', () => {
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: 0 }), 60);
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: 30 }), 60);
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: 99999 }), 3600);
  assert.equal(getIdleSleepSeconds({ idleSleepSeconds: -100 }), 60);
});

test('getMaxRounds 缺字段/null/undefined → 默认 40', () => {
  assert.equal(getMaxRounds({}), 40);
  assert.equal(getMaxRounds({ maxRounds: null }), 40);
  assert.equal(getMaxRounds({ maxRounds: undefined }), 40);
  assert.equal(getMaxRounds(null), 40);
});

test('getMaxRounds 非数字 → 默认 40', () => {
  assert.equal(getMaxRounds({ maxRounds: 'abc' }), 40);
  assert.equal(getMaxRounds({ maxRounds: NaN }), 40);
});

test('getMaxRounds 合法数字 → 透传 + 取整', () => {
  assert.equal(getMaxRounds({ maxRounds: 25 }), 25);
  assert.equal(getMaxRounds({ maxRounds: 80 }), 80);
  assert.equal(getMaxRounds({ maxRounds: 40.6 }), 41);
  assert.equal(getMaxRounds({ maxRounds: '30' }), 30);
});

test('getMaxRounds 越界 → clamp 到 [5, 500]', () => {
  assert.equal(getMaxRounds({ maxRounds: 0 }), 5);
  assert.equal(getMaxRounds({ maxRounds: 1 }), 5);
  assert.equal(getMaxRounds({ maxRounds: 99999 }), 500);
  assert.equal(getMaxRounds({ maxRounds: -10 }), 5);
});
