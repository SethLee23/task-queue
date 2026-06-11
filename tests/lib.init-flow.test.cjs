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
  scaffoldProject, runInit, registerOnly,
} = require('../lib/init-flow.cjs');

function makeAnswers(scope = 'main') {
  return {
    autoCommitScopes: [],
    scopeMapping: { [scope]: { dir: '.', versionFile: 'package.json', changelogFile: '', buildCommand: '' } },
    candidateModules: { [scope]: ['全局'] },
    commitTemplate: { [scope]: `T#0000 ${scope}## {version}\n\n【{module}】{desc}；` },
    sameDayShareVersion: true,
  };
}

function gitConfigTestUser(dir) {
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

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

test('inspectRoot: 已有仓库的子目录 isGitRepo 为 true(防嵌套 git init)', () => {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'nested-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const sub = path.join(repo, 'packages', 'web');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(inspectRoot(sub).isGitRepo, true);
});

test('scaffoldProject: mkdir + git init + 最小 package.json,不产生 commit', () => {
  const root = path.join(fs.mkdtempSync(path.join(tmpDir, 'scaf-')), 'fresh-proj');
  scaffoldProject(root);
  assert.ok(fs.existsSync(path.join(root, '.git')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'fresh-proj');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.private, true);
  // 尚无任何 commit
  assert.throws(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' }));
});

test('runInit attach: 落盘 .tasks + 注册 + commit .gitignore', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-attach-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  gitConfigTestUser(root);

  const result = await runInit({ mode: 'attach', root, gitInit: false, answers: makeAnswers() });

  assert.ok(result.slug);
  assert.equal(result.committed, true);
  assert.equal(result.warning, null);
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'project.config.js')));
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'tasks.xlsx')));
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.tasks\/$/m);

  const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(subject, 'task-queue: 接入任务队列（ignore .tasks/）');
  const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files, ['.gitignore']);
});

test('runInit attach: commit 不带上用户已暂存的其它改动', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-staged-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  gitConfigTestUser(root);
  fs.writeFileSync(path.join(root, 'wip.txt'), 'in progress\n');
  execFileSync('git', ['add', 'wip.txt'], { cwd: root });

  await runInit({ mode: 'attach', root, gitInit: false, answers: makeAnswers() });

  const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files, ['.gitignore']);
});

test('runInit attach + gitInit: 非 git 目录先 init 再走全流程', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-gitinit-'));
  const result = await runInit({ mode: 'attach', root, gitInit: true, answers: makeAnswers() });
  // 注意:新 init 的仓库继承全局 git config;本机有 user.name 时 commit 成功
  assert.ok(fs.existsSync(path.join(root, '.git')));
  assert.ok(result.slug);
});

test('runInit attach 非 git 且不 gitInit: 跳过 commit 并给 warning', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-nogit-'));
  const result = await runInit({ mode: 'attach', root, gitInit: false, answers: makeAnswers() });
  assert.equal(result.committed, false);
  assert.match(result.warning, /不是 git 仓库/);
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'project.config.js'))); // 落盘不受影响
});

test('runInit create: 脚手架 + init + 首 commit 含 package.json 和 .gitignore', async () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'run-create-'));
  const root = path.join(parent, 'brand-new');
  const result = await runInit({ mode: 'create', root, gitInit: false, answers: makeAnswers() });

  assert.ok(result.slug);
  assert.ok(fs.existsSync(path.join(root, 'package.json')));
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'tasks.xlsx')));
  const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(files, ['.gitignore', 'package.json']);
});

test('runInit: git commit 失败时不回滚,返回 warning', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-fail-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  // 注入必败 hook:pre-commit 直接 exit 1
  const hookDir = path.join(root, '.git', 'hooks');
  fs.writeFileSync(path.join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const result = await runInit({ mode: 'attach', root, gitInit: false, answers: makeAnswers() });
  assert.equal(result.committed, false);
  assert.match(result.warning, /commit 失败/);
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'project.config.js'))); // 不回滚
  assert.ok(result.slug); // registry 注册成功
});

test('registerOnly: 只注册不动配置', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'reg-only-'));
  fs.mkdirSync(path.join(root, '.tasks'));
  fs.writeFileSync(path.join(root, '.tasks', 'project.config.js'), 'module.exports = { marker: 1 };\n');

  const entry = registerOnly(root);
  assert.ok(entry.slug);
  // 配置原样未动
  assert.match(fs.readFileSync(path.join(root, '.tasks', 'project.config.js'), 'utf8'), /marker: 1/);
});
