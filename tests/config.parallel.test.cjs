'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadProjectConfig } = require('../lib/config.cjs');

function mkCfgDir(parallelLiteral) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-parallel-'));
  fs.mkdirSync(path.join(dir, '.tasks'));
  fs.writeFileSync(path.join(dir, '.tasks', 'project.config.js'), `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true' },
      versionFiles: { web: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md' },
      inferModule: () => 'm',
      commitMessage: () => 'msg',
      ${parallelLiteral}
    };
  `);
  return dir;
}

test('parallel 字段缺失时返回默认 disabled(存量项目兼容)', () => {
  const cfg = loadProjectConfig(mkCfgDir(''));
  assert.deepEqual(cfg.parallel, { enabled: false, maxConcurrency: 3, allowSameScope: false });
});

test('parallel 字段存在时缺省项合并默认值', () => {
  const cfg = loadProjectConfig(mkCfgDir('parallel: { enabled: true, maxConcurrency: 5 },'));
  assert.equal(cfg.parallel.enabled, true);
  assert.equal(cfg.parallel.maxConcurrency, 5);
  assert.equal(cfg.parallel.allowSameScope, false);
});
