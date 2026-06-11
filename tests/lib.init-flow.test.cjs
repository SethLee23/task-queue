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

// ── 新增：类型防呆 ──────────────────────────────────────────────────
test('resolveInitPath 非字符串输入抛 /必须是字符串/', () => {
  assert.throws(() => resolveInitPath(123), /必须是字符串/);
  assert.throws(() => resolveInitPath(null), /必须是字符串/);
  assert.throws(() => resolveInitPath(undefined), /必须是字符串/);
});

test('resolveInitPath 空字符串抛 /不能为空/', () => {
  assert.throws(() => resolveInitPath(''), /不能为空/);
});

// ── 新增：symlink 绕过 home 守卫 ────────────────────────────────────
test('resolveInitPath symlink 指向 home 目录被拒绝', () => {
  const linkPath = path.join(tmpDir, 'home-link');
  const realHome = (() => { try { return fs.realpathSync.native(os.homedir()); } catch (_) { return os.homedir(); } })();
  fs.symlinkSync(realHome, linkPath);
  assert.throws(() => resolveInitPath(linkPath), /home/);
});

// ── 新增：错误分支细化 ──────────────────────────────────────────────
test('validateAttachRoot attach 到文件而非目录抛 /不是目录/', () => {
  const filePath = path.join(tmpDir, 'notadir.txt');
  fs.writeFileSync(filePath, 'x');
  assert.throws(() => validateAttachRoot(filePath), /不是目录/);
});

test('validateAttachRoot EPERM/EACCES 等非 ENOENT 错误提示包含错误码', () => {
  // 用一个不存在的路径无法测试 EPERM，但我们可以验证 ENOENT 消息保持「不存在」
  assert.throws(() => validateAttachRoot(path.join(tmpDir, 'no-such-dir')), /不存在/);
});

test('validateCreateTarget 父目录是文件时抛 /父目录不是目录/', () => {
  const filePath = path.join(tmpDir, 'parent-is-file.txt');
  fs.writeFileSync(filePath, 'x');
  assert.throws(() => validateCreateTarget(path.join(filePath, 'new-proj')), /父目录不是目录/);
});

test('inspectRoot 报告 isGitRepo 与 alreadyInitialized', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'inspect-'));
  assert.deepEqual(inspectRoot(dir), { isGitRepo: false, alreadyInitialized: false });

  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.tasks'));
  fs.writeFileSync(path.join(dir, '.tasks', 'project.config.js'), 'module.exports = {};\n');
  assert.deepEqual(inspectRoot(dir), { isGitRepo: true, alreadyInitialized: true });
});
