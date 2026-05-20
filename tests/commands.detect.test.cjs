// tests/commands.detect.test.cjs — detect 命令单元测试
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const detectCmd = require('../commands/detect.cjs');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-detect-'));
after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

/**
 * 捕获 process.stdout.write 输出，返回拼接后的字符串。
 * @param {() => Promise<void>} fn
 * @returns {Promise<string>}
 */
function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = orig;
  }).then(() => chunks.join(''));
}

test('单包项目：type=single，version 和 changelogFile 正确', async () => {
  const proj = fs.mkdtempSync(path.join(tmpBase, 'single-'));

  // 创建根 package.json
  fs.writeFileSync(
    path.join(proj, 'package.json'),
    JSON.stringify({ name: 'test-single', version: '1.0.0', scripts: { build: 'echo build' } }),
  );

  // 创建 README.md 含版本标题
  fs.writeFileSync(
    path.join(proj, 'README.md'),
    '# Test Project\n\n## 1.0.0\n\n- 初始版本\n',
  );

  const out = await capture(() => detectCmd(proj, []));
  const result = JSON.parse(out);

  assert.equal(result.type, 'single');
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].version, '1.0.0');
  assert.equal(result.packages[0].changelogFile, 'README.md');
  assert.equal(result.packages[0].buildCommand, 'npm run build');
});

test('monorepo：type=monorepo，packages 含根包和 web 子包', async () => {
  const proj = fs.mkdtempSync(path.join(tmpBase, 'mono-'));

  // 根 package.json
  fs.writeFileSync(
    path.join(proj, 'package.json'),
    JSON.stringify({ name: 'mono-root', version: '4.6.3', scripts: { build: 'node ci/build.cjs' } }),
  );

  // CHANGELOG.md 含版本标题
  fs.writeFileSync(
    path.join(proj, 'CHANGELOG.md'),
    '# Changelog\n\n## 4.6.3\n\n- 更新内容\n',
  );

  // web/ 子包
  fs.mkdirSync(path.join(proj, 'web'));
  fs.writeFileSync(
    path.join(proj, 'web', 'package.json'),
    JSON.stringify({ name: 'mono-web', version: '4.0.31', scripts: { build: 'vite build' } }),
  );
  fs.writeFileSync(
    path.join(proj, 'web', 'README.md'),
    '# Web\n\n## 4.0.31\n\n- 前端更新\n',
  );

  // web/src/view/ 模拟模块目录
  fs.mkdirSync(path.join(proj, 'web', 'src', 'view', 'Router'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'web', 'src', 'view', 'Service'), { recursive: true });

  const out = await capture(() => detectCmd(proj, []));
  const result = JSON.parse(out);

  assert.equal(result.type, 'monorepo');
  assert.ok(result.packages.length >= 2, `期望 ≥2 个包，实际 ${result.packages.length}`);

  const webPkg = result.packages.find(p => p.dir === 'web');
  assert.ok(webPkg, 'packages 应包含 web 子包');
  assert.equal(webPkg.version, '4.0.31');
  assert.equal(webPkg.changelogFile, 'web/README.md');
  assert.ok(webPkg.candidateModules.includes('路由管理'), `candidateModules 应含路由管理，实际: ${JSON.stringify(webPkg.candidateModules)}`);
  assert.ok(webPkg.candidateModules.includes('服务管理 L7'), `candidateModules 应含服务管理 L7`);

  const rootPkg = result.packages.find(p => p.dir === '.');
  assert.ok(rootPkg, 'packages 应包含根包');
  assert.equal(rootPkg.version, '4.6.3');
  assert.equal(rootPkg.changelogFile, 'CHANGELOG.md');
});

test('detectSameDayShare：无 git 仓库时返回 unknown，不抛错', async () => {
  // 在非 git 目录调用，不应抛错
  const proj = fs.mkdtempSync(path.join(tmpBase, 'nogit-'));
  fs.writeFileSync(
    path.join(proj, 'package.json'),
    JSON.stringify({ name: 'no-git', version: '1.0.0' }),
  );

  const out = await capture(() => detectCmd(proj, []));
  const result = JSON.parse(out);

  // commitPattern 应为 null（无 git）
  assert.equal(result.commitPattern, null);
  // sameDayShareVersion 应为 'unknown'
  assert.equal(result.sameDayShareVersion, 'unknown');
});
