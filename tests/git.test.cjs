const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { gitStatus, gitAdd, gitCommit, gitLogSubjects, gitDiffStat, gitCommitPaths, gitInitRepo } = require('../lib/git.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-git-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function setupRepo() {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  execSync('git init -b main', { cwd: repo });
  execSync('git config user.email "t@t.com"', { cwd: repo });
  execSync('git config user.name "t"', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'init');
  execSync('git add .', { cwd: repo });
  execSync('git commit -m "init"', { cwd: repo });
  return repo;
}

test('gitStatus 列出改动文件', () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
  const changed = gitStatus(repo);
  assert.deepEqual(changed.sort(), ['a.txt', 'b.txt']);
});

test('gitStatus 干净时返回空数组', () => {
  const repo = setupRepo();
  assert.deepEqual(gitStatus(repo), []);
});

test('gitAdd + gitCommit 创建新 commit', () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  gitAdd(repo, ['a.txt']);
  gitCommit(repo, 'feat: add a');
  const subjects = gitLogSubjects(repo, 5);
  assert.equal(subjects[0], 'feat: add a');
});

test('gitCommit pre-commit hook 失败抛错', () => {
  const repo = setupRepo();
  const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hookPath, 0o755);
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x');
  gitAdd(repo, ['x.txt']);
  assert.throws(() => gitCommit(repo, 'should fail'), /pre-commit|hook|exit 1|失败/i);
});

test('gitDiffStat 返回 stat 输出', () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), 'changed');
  const stat = gitDiffStat(repo);
  assert.match(stat, /README\.md/);
});

test('gitStatus 重命名条目只返回新路径', () => {
  const repo = setupRepo();
  // commit 一个文件进去
  fs.writeFileSync(path.join(repo, 'old.txt'), 'content');
  execSync('git add old.txt', { cwd: repo });
  execSync('git commit -m "add old.txt"', { cwd: repo });
  // 用 git mv 重命名
  execSync('git mv old.txt new.txt', { cwd: repo });
  const changed = gitStatus(repo);
  // 应该只有 new.txt，不含 ' -> '
  assert.deepEqual(changed, ['new.txt']);
});

test('gitCommitPaths 只提交指定文件,不带上其它已暂存改动', () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  execFileSync('git', ['add', 'a.txt', 'b.txt'], { cwd: repo });

  gitCommitPaths(repo, 'only a', ['a.txt']);

  const lastFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'],
    { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(lastFiles, ['a.txt']);
  // b.txt 仍在暂存区未被提交
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'],
    { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(staged, 'b.txt');
});

test('gitInitRepo 在空目录初始化 git 仓库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-init-test-'));
  gitInitRepo(dir);
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  fs.rmSync(dir, { recursive: true, force: true });
});
