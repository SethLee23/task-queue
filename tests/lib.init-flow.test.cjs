'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-flow-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const {
  resolveInitPath, validateAttachRoot, validateCreateTarget, inspectRoot,
} = require('../lib/init-flow.cjs');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

test('resolveInitPath 展开 ~ 为 home 目录', () => {
  assert.equal(resolveInitPath('~/foo'), path.join(os.homedir(), 'foo'));
});

test('resolveInitPath 拒绝相对路径', () => {
  assert.throws(() => resolveInitPath('foo/bar'), /绝对路径/);
});

test('resolveInitPath 拒绝根目录与 home 本身', () => {
  assert.throws(() => resolveInitPath('/'), /根目录/);
  assert.throws(() => resolveInitPath(os.homedir()), /home/);
  assert.throws(() => resolveInitPath('~'), /home/);
});

test('resolveInitPath 规范化 .. 段后再校验', () => {
  // 借 .. 绕回 home 也要被拒
  assert.throws(() => resolveInitPath(path.join(os.homedir(), 'x', '..')), /home/);
});

test('validateAttachRoot: 目录存在通过,不存在抛错', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'attach-'));
  validateAttachRoot(dir); // 不抛
  assert.throws(() => validateAttachRoot(path.join(tmpDir, 'nope')), /不存在/);
});

test('validateCreateTarget: 目标已存在抛错,父目录不存在抛错', () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'parent-'));
  validateCreateTarget(path.join(parent, 'new-proj')); // 不抛
  assert.throws(() => validateCreateTarget(parent), /已存在/);
  assert.throws(() => validateCreateTarget(path.join(tmpDir, 'ghost', 'new-proj')), /父目录不存在/);
});

test('inspectRoot 报告 isGitRepo 与 alreadyInitialized', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'inspect-'));
  assert.deepEqual(inspectRoot(dir), { isGitRepo: false, alreadyInitialized: false });

  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.tasks'));
  fs.writeFileSync(path.join(dir, '.tasks', 'project.config.js'), 'module.exports = {};\n');
  assert.deepEqual(inspectRoot(dir), { isGitRepo: true, alreadyInitialized: true });
});
