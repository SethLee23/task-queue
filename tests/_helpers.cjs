'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createBlankWorkbook, withWorkbook, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');

/**
 * 创建一个新临时根目录（调用方负责清理），并提供 setupProject 工厂
 * @param {string} prefix mkdtemp 前缀
 * @returns {{ tmpDir: string, setupProject: (rows: object[]) => Promise<string> }}
 */
function createTmpProjectFactory(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  async function setupProject(rows) {
    const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.mkdirSync(path.join(proj, '.tasks'));
    const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
    await createBlankWorkbook(xlsx);
    if (rows.length > 0) {
      await withWorkbook(xlsx, async wb => {
        const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
        rows.forEach(r => ws.addRow(r));
      });
    }
    return proj;
  }
  return { tmpDir, setupProject };
}

/**
 * 拦截 process.stdout.write，返回拼接后的字符串
 * @param {() => Promise<void> | void} fn
 * @returns {Promise<string>}
 */
function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = origWrite;
  }).then(() => chunks.join(''));
}

/**
 * 创建 tmp git 项目工厂:init 仓库 + 初始 commit + 空 node_modules + .tasks/tasks.xlsx。
 * 用于需要真实 git 历史的测试(worktree / merge / recover orphan)。
 * @param {string} prefix mkdtemp 前缀
 * @returns {{ tmpDir: string, setupProject: (rows: object[]) => Promise<string> }}
 */
function createTmpGitProjectFactory(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  async function setupProject(rows) {
    const proj = fs.mkdtempSync(path.join(tmpDir, 'gitproj-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: proj });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'README.md'), '# test\n');
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.1' }, null, 2) + '\n');
    fs.writeFileSync(path.join(proj, '.gitignore'), '.tasks/\nnode_modules/\n');
    execFileSync('git', ['add', '.'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: proj });
    fs.mkdirSync(path.join(proj, 'node_modules'));
    fs.mkdirSync(path.join(proj, '.tasks'));
    const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
    await createBlankWorkbook(xlsx);
    if (rows.length > 0) {
      await withWorkbook(xlsx, async wb => {
        const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
        rows.forEach(r => ws.addRow(r));
      });
    }
    return proj;
  }
  return { tmpDir, setupProject };
}

module.exports = { createTmpProjectFactory, createTmpGitProjectFactory, captureStdout };
