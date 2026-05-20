'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const {
  createBlankWorkbook,
  withWorkbook,
  readRows,
  SHEET_IN_PROGRESS,
  SHEET_ARCHIVED,
} = require('../lib/workbook.cjs');
const doneCmd = require('../commands/done.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-done-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function setupProject({
  scope,
  autoCommit,
  rows,
  initialFiles = {},
  inferModuleReturn = '路由管理',
}) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  execSync('git init -b main', { cwd: proj });
  execSync('git config user.email "t@t.com"', { cwd: proj });
  execSync('git config user.name "t"', { cwd: proj });
  const pkg = { name: 'fake', version: '1.0.0' };
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(proj, 'README.md'), '# fake\n\n## 1.0.0\n');
  for (const [p, content] of Object.entries(initialFiles)) {
    fs.mkdirSync(path.dirname(path.join(proj, p)), { recursive: true });
    fs.writeFileSync(path.join(proj, p), content);
  }
  // 把 .tasks/ 加入 .gitignore，避免 task-queue 内部文件被 git status 当成改动
  fs.writeFileSync(path.join(proj, '.gitignore'), '.tasks/\n');

  fs.mkdirSync(path.join(proj, '.tasks'));
  const cfgPath = path.join(proj, '.tasks', 'project.config.js');
  fs.writeFileSync(
    cfgPath,
    `module.exports = {
    scopes: { ${scope}: { dir: '.', autoCommit: ${autoCommit} } },
    buildCommands: { ${scope}: 'true' },
    versionFiles: { ${scope}: 'package.json' },
    changelogFiles: { ${scope}: 'README.md' },
    sameDayShareVersion: true,
    inferModule: () => ${inferModuleReturn === null ? 'null' : `'${inferModuleReturn}'`},
    commitMessage: ({ scope, module, desc, version }) =>
      \`T#0000 \${scope}## \${version}\\n\\n【\${module}】\${desc}；\`,
    autoPush: false,
  };`
  );
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  await withWorkbook(xlsx, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    rows.forEach(r => ws.addRow(r));
  });
  // .gitignore 先 commit 进去，把 .tasks/ 从工作区改动里隔离
  execSync('git add .', { cwd: proj });
  execSync('git commit -m "init"', { cwd: proj });
  return proj;
}

test('done 成功路径：autoCommit=true，无风险，自动 commit + 归档', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/foo.txt': 'old' },
    rows: [
      {
        id: 1,
        desc: '改 foo',
        scope: 'web',
        priority: '高',
        status: '进行中',
        note: '',
        question: '',
        risk: '',
        ctime: '2026-05-20T10:00:00Z',
        ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/foo.txt'), 'new');
  await doneCmd(proj, ['1']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 0);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].status, '已完成');
  const logs = execSync('git log -1 --pretty=%B', { cwd: proj, encoding: 'utf8' });
  assert.match(logs, /T#0000 web##.*【路由管理】改 foo；/s);
  const pkg = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.0.1');
});

test('done 当 scope.autoCommit=false 时不 commit，转 review', async () => {
  const proj = await setupProject({
    scope: 'core',
    autoCommit: false,
    initialFiles: { 'src/x.ts': 'old' },
    rows: [
      {
        id: 1,
        desc: '改 x',
        scope: 'core',
        priority: '高',
        status: '进行中',
        note: '',
        question: '',
        risk: '',
        ctime: '2026-05-20T10:00:00Z',
        ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/x.ts'), 'new');
  await doneCmd(proj, ['1']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg.length, 1);
  assert.equal(inProg[0].status, '已完成-待review');
  assert.match(inProg[0].risk, /scope.*不允许自动 commit/i);
  const logCount = execSync('git rev-list HEAD --count', { cwd: proj, encoding: 'utf8' }).trim();
  assert.equal(logCount, '1');
});

test('done 当 inferModule 返回 null 时转 review', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    inferModuleReturn: null,
    initialFiles: { 'src/y.ts': 'old' },
    rows: [
      {
        id: 1,
        desc: '改 y',
        scope: 'web',
        priority: '高',
        status: '进行中',
        note: '',
        question: '',
        risk: '',
        ctime: '2026-05-20T10:00:00Z',
        ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/y.ts'), 'new');
  await doneCmd(proj, ['1']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg[0].status, '已完成-待review');
  assert.match(inProg[0].risk, /模块名推断失败/);
});

test('done 工作区无改动时不 commit，状态置已完成并归档', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    rows: [
      {
        id: 1,
        desc: '空任务',
        scope: 'web',
        priority: '高',
        status: '进行中',
        note: '',
        question: '',
        risk: '',
        ctime: '2026-05-20T10:00:00Z',
        ftime: '',
      },
    ],
  });
  await doneCmd(proj, ['1']);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(archived[0].status, '已完成');
  const logCount = execSync('git rev-list HEAD --count', { cwd: proj, encoding: 'utf8' }).trim();
  assert.equal(logCount, '1');
});

test('done pre-commit hook 失败时转 review', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/a.ts': 'old' },
    rows: [
      {
        id: 1,
        desc: 'a 改动',
        scope: 'web',
        priority: '高',
        status: '进行中',
        note: '',
        question: '',
        risk: '',
        ctime: '2026-05-20T10:00:00Z',
        ftime: '',
      },
    ],
  });
  const hookPath = path.join(proj, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho hookfail >&2\nexit 1\n');
  fs.chmodSync(hookPath, 0o755);
  fs.writeFileSync(path.join(proj, 'src/a.ts'), 'new');
  await doneCmd(proj, ['1']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg[0].status, '已完成-待review');
  assert.match(inProg[0].risk, /commit 阶段失败|hookfail|hook/i);
});

test('done desc 含 $1 时 changelog 写入字面字符串不被替换', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/cfg.ts': 'old' },
    rows: [
      {
        id: 1,
        desc: '改 $1 配置',
        scope: 'web',
        priority: '高',
        status: '进行中',
        note: '',
        question: '',
        risk: '',
        ctime: '2026-05-20T10:00:00Z',
        ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/cfg.ts'), 'new');
  await doneCmd(proj, ['1']);
  const readme = fs.readFileSync(path.join(proj, 'README.md'), 'utf8');
  assert.ok(
    readme.includes('【路由管理】改 $1 配置；'),
    `README.md 应包含字面 $1，实际内容：${readme}`,
  );
});
