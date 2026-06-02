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
  changelogFile = 'README.md',
  versionFile = 'package.json',
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
  // changelogFile === null 表示"顶级 changelogFiles 存在但 scope 下无值"(模拟漏配 scope 行)
  const changelogLine = changelogFile === null
    ? 'changelogFiles: {},'
    : `changelogFiles: { ${scope}: '${changelogFile}' },`;
  fs.writeFileSync(
    cfgPath,
    `module.exports = {
    scopes: { ${scope}: { dir: '.', autoCommit: ${autoCommit} } },
    buildCommands: { ${scope}: 'true' },
    versionFiles: { ${scope}: '${versionFile}' },
    ${changelogLine}
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
  await doneCmd(proj, ['1', 'test summary']);
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
  await doneCmd(proj, ['1', 'test summary']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg.length, 1);
  assert.equal(inProg[0].status, '已完成-待review');
  assert.match(inProg[0].risk, /scope.*不允许自动 commit/i);
  const logCount = execSync('git rev-list HEAD --count', { cwd: proj, encoding: 'utf8' }).trim();
  assert.equal(logCount, '1');
});

// 回归 2026-05-29 ditto 任务 #14:回答型任务在 autoCommit=false 的 scope 上,
// done 走 transitionToReview 只写 risk 列、丢弃 summary —— 用户在 dashboard 看到空回复
// ("你回复是空的啊")。修复:转 review 时把 summary 作为 [done] 块写进 note,答案得以保全。
test('done 当 scope.autoCommit=false 时:summary(答案)写进 note 不丢失', async () => {
  const proj = await setupProject({
    scope: 'ditto',
    autoCommit: false,
    rows: [
      {
        id: 14, desc: '你这里说的服务端的全局脚本在哪?', scope: 'ditto', priority: '中',
        status: '进行中', note: '原有历史', question: '', risk: '',
        ctime: '2026-05-29T07:00:00Z', ftime: '',
      },
    ],
  });
  const answer = '结论:它叫「临时脚本」,URL 是 /temp-scripts,见 server/dashboard/src/pages/ScriptsPage.tsx:92';
  await doneCmd(proj, ['14', answer]);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg.length, 1);
  assert.equal(inProg[0].status, '已完成-待review');
  assert.match(inProg[0].risk, /scope.*不允许自动 commit/i);
  // 关键断言:summary(答案)必须被保全在 note 的 [done] 块里,而不是被丢弃
  assert.match(inProg[0].note, DONE_HEADER_RE, 'note 顶部应有 [done] 块');
  assert.ok(inProg[0].note.includes(answer), `答案应写进 note,实际 note: ${inProg[0].note}`);
  assert.match(inProg[0].note, /---\n原有历史$/, '旧 note 应保留并以 --- 分隔');
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
  await doneCmd(proj, ['1', 'test summary']);
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
  await doneCmd(proj, ['1', 'test summary']);
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
  await doneCmd(proj, ['1', 'test summary']);
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
  await doneCmd(proj, ['1', 'test summary']);
  const readme = fs.readFileSync(path.join(proj, 'README.md'), 'utf8');
  assert.ok(
    readme.includes('【路由管理】改 $1 配置；'),
    `README.md 应包含字面 $1，实际内容：${readme}`,
  );
});

const DONE_HEADER_RE = /^\[done \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/;

test('done commit 路径 + summary：note 顶部含 [done]+commit+summary，分隔旧 note', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/foo.txt': 'old' },
    rows: [
      {
        id: 1, desc: '改 foo', scope: 'web', priority: '高', status: '进行中',
        note: '旧 note 第一行\n旧 note 第二行',
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/foo.txt'), 'new');
  await doneCmd(proj, ['1', '改了 foo.txt，验证通过']);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  const note = archived[0].note;
  assert.match(note, DONE_HEADER_RE);
  assert.match(note, /\ncommit [0-9a-f]{7,} · 【路由管理】 1\.0\.1\n/);
  assert.match(note, /\n改了 foo\.txt，验证通过\n---\n旧 note 第一行\n旧 note 第二行$/);
});

test('done 缺 summary：转 review 并写入清晰 risk 提示', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/foo.txt': 'old' },
    rows: [
      {
        id: 1, desc: '改 foo', scope: 'web', priority: '高', status: '进行中',
        note: '原 note',
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/foo.txt'), 'new');
  // 不传 summary —— 应当转 review,note 不被改动,工作区也不被 commit
  await doneCmd(proj, ['1']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 1, '任务应留在进行中表');
  assert.equal(archived.length, 0, '不应归档');
  assert.equal(inProg[0].status, '已完成-待review');
  assert.match(inProg[0].risk, /未提供 summary/);
  // 工作区改动还在,没有被 commit
  const status = execSync('git status --porcelain', { cwd: proj, encoding: 'utf8' });
  assert.match(status, /src\/foo\.txt/, '改动应仍在工作区');
});

// 同样验证空字符串 summary 也被拒绝
test('done summary 为空白字符串：仍转 review', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/foo.txt': 'old' },
    rows: [
      {
        id: 1, desc: '改 foo', scope: 'web', priority: '高', status: '进行中',
        note: '原 note',
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/foo.txt'), 'new');
  await doneCmd(proj, ['1', '   ']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg.length, 1);
  assert.equal(inProg[0].status, '已完成-待review');
  assert.match(inProg[0].risk, /未提供 summary/);
});

test('done 无文件改动 + summary：note 顶部含 [done]+"无文件改动"+summary', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    rows: [
      {
        id: 1, desc: '空任务', scope: 'web', priority: '高', status: '进行中',
        note: '',
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  await doneCmd(proj, ['1', '只是核对了一下，无须改码']);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  const note = archived[0].note;
  assert.match(note, DONE_HEADER_RE);
  assert.match(note, /\n无文件改动\n只是核对了一下，无须改码$/);
  // 旧 note 为空 → 不应有 \n---\n 分隔
  assert.equal(note.includes('\n---\n'), false);
});

// 回归 2026-05-25 任务 #1 EISDIR:
// changelogFiles[scope] 为空串 → path.join(root, '') === root,fs.readFileSync(目录) 抛 EISDIR
// 把整个 commit 流程吞掉转 review。修复后:空串 → 跳过 changelog 追加,正常 commit + 归档。
test('done changelogFiles[scope] 为空字符串：跳过 changelog 追加并正常 commit 归档（回归 EISDIR）', async () => {
  const proj = await setupProject({
    scope: 'core',
    autoCommit: true,
    changelogFile: '',
    initialFiles: { 'src/foo.txt': 'old' },
    rows: [
      {
        id: 1, desc: '改 foo', scope: 'core', priority: '高', status: '进行中',
        note: '',
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/foo.txt'), 'new');
  await doneCmd(proj, ['1', 'summary 见此']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 0, '应当归档,不应留在进行中(EISDIR 回归)');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].status, '已完成');
  // README 原内容不被修改(因为没配 changelog)
  const readme = fs.readFileSync(path.join(proj, 'README.md'), 'utf8');
  assert.equal(readme, '# fake\n\n## 1.0.0\n', 'README.md 不应被改');
  // 版本号仍正常 bump
  const pkg = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.0.1');
});

test('done changelogFiles[scope] 缺失（scope 下未列）：同样跳过 changelog 追加,不崩', async () => {
  const proj = await setupProject({
    scope: 'core',
    autoCommit: true,
    changelogFile: null,
    initialFiles: { 'src/bar.txt': 'old' },
    rows: [
      {
        id: 1, desc: '改 bar', scope: 'core', priority: '高', status: '进行中',
        note: '',
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/bar.txt'), 'new');
  await doneCmd(proj, ['1', '另一段 summary']);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].status, '已完成');
});

test('done versionFiles[scope] 为空字符串：转 review 不崩(避免读目录抛 EISDIR)', async () => {
  const proj = await setupProject({
    scope: 'core',
    autoCommit: true,
    versionFile: '',
    initialFiles: { 'src/baz.txt': 'old' },
    rows: [
      {
        id: 1, desc: '改 baz', scope: 'core', priority: '高', status: '进行中',
        note: '',
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/baz.txt'), 'new');
  await doneCmd(proj, ['1', 'baz summary']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg.length, 1, '应留在进行中(转 review)');
  assert.equal(inProg[0].status, '已完成-待review');
  assert.match(inProg[0].risk, /versionFiles.*未配置|无法 bump/);
});

// 回归 2026-05-25 任务 #2:
// done.cjs 在 stage 时直接 git add 整个工作区,把 .tasks/project.config.js 等 task-queue 私有文件
// 一起 commit 进业务 commit。修复:gitStatus 后过滤 .tasks/ 前缀,确保不混入归档 commit。
test('done 不应 stage .tasks/ 下的文件（task-queue 私有空间隔离）', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/foo.txt': 'old' },
    rows: [
      {
        id: 1, desc: '改 foo', scope: 'web', priority: '高', status: '进行中',
        note: '',
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  // 关键:从 .gitignore 移除 .tasks/,模拟真实项目里 .tasks/project.config.js 入 git 跟踪的场景
  fs.writeFileSync(path.join(proj, '.gitignore'), '');
  execSync('git add .gitignore', { cwd: proj });
  // 先把 .tasks/ 当前内容 commit 进 git(模拟初始状态:.tasks/project.config.js + .tasks/tasks.xlsx 已入库)
  execSync('git add .tasks', { cwd: proj });
  execSync('git commit -m "track .tasks"', { cwd: proj });
  // 现在再修改 .tasks/project.config.js,让 git status 把它视为改动
  const cfgPath = path.join(proj, '.tasks', 'project.config.js');
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8') + '\n// user edit\n');
  // 业务文件也有改动
  fs.writeFileSync(path.join(proj, 'src/foo.txt'), 'new');

  // 验证前置条件:gitStatus 此时能看到 2 个改动
  const preStatus = execSync('git status --porcelain', { cwd: proj, encoding: 'utf8' });
  assert.match(preStatus, /src\/foo\.txt/);
  assert.match(preStatus, /\.tasks\/project\.config\.js/);

  await doneCmd(proj, ['1', 'test summary']);

  // 验证 commit 只含 src/foo.txt,不含 .tasks/project.config.js
  const committedFiles = execSync(
    'git show --pretty="" --name-only HEAD',
    { cwd: proj, encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);
  // 应当包含 src/foo.txt 和 package.json(版本 bump) + README.md(changelog),但绝不含 .tasks/*
  assert.ok(
    committedFiles.includes('src/foo.txt'),
    `应 commit src/foo.txt,实际 commit 了: ${committedFiles.join(',')}`,
  );
  assert.equal(
    committedFiles.some(f => f.startsWith('.tasks/')),
    false,
    `不应 commit .tasks/ 下任何文件,实际 commit 了: ${committedFiles.join(',')}`,
  );

  // .tasks/project.config.js 改动仍留在工作区(未 stage 也未 commit)
  const postStatus = execSync('git status --porcelain', { cwd: proj, encoding: 'utf8' });
  assert.match(
    postStatus,
    /\.tasks\/project\.config\.js/,
    `.tasks/project.config.js 应仍在工作区,实际 status: ${postStatus}`,
  );

  // 任务已归档
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].status, '已完成');
});

test('buildDoneBlock + prependDoneBlock 单元逻辑', () => {
  const { buildDoneBlock, prependDoneBlock } = doneCmd;
  // commit 路径
  const a = buildDoneBlock({
    ts: '2026-05-21 18:30', commitHash: 'abc1234',
    version: '1.2.3', moduleName: '路由管理', summary: 'did X',
  });
  assert.equal(a, '[done 2026-05-21 18:30]\ncommit abc1234 · 【路由管理】 1.2.3\ndid X');
  // 无改动 + 无 summary
  const b = buildDoneBlock({ ts: '2026-05-21 18:30' });
  assert.equal(b, '[done 2026-05-21 18:30]\n无文件改动');
  // summary 仅空白也忽略
  const c = buildDoneBlock({ ts: '2026-05-21 18:30', summary: '   ' });
  assert.equal(c, '[done 2026-05-21 18:30]\n无文件改动');
  // prepend 行为
  assert.equal(prependDoneBlock('', 'BLOCK'), 'BLOCK');
  assert.equal(prependDoneBlock(undefined, 'BLOCK'), 'BLOCK');
  assert.equal(prependDoneBlock('OLD', 'BLOCK'), 'BLOCK\n---\nOLD');
});

test('done 当 checklist 有未勾项时:回退到 TODO,note 顶部加被拒说明,不 commit 不归档', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/foo.txt': 'old' },
    rows: [
      {
        id: 7, desc: '迁移子任务', scope: 'web', priority: '中', status: '进行中',
        note: '原 note',
        checklist: JSON.stringify([
          { text: 'A 步', done: true },
          { text: 'B 步', done: true },
          { text: 'C 步', done: false },
        ]),
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/foo.txt'), 'new');
  await doneCmd(proj, ['7', '已经全部完成']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 1, '任务应留在进行中表');
  assert.equal(archived.length, 0, '不应归档');
  assert.equal(inProg[0].status, '待办', '应回退到 TODO');
  assert.match(inProg[0].note, /done 被拒/);
  assert.match(inProg[0].note, /2\/3/);
  assert.match(inProg[0].note, /下一项: C 步/);
  assert.match(inProg[0].note, /worker summary: 已经全部完成/);
  assert.match(inProg[0].note, /原 note/, '旧 note 应被保留');
  // 工作区改动仍在,没有 commit
  const status = execSync('git status --porcelain', { cwd: proj, encoding: 'utf8' });
  assert.match(status, /src\/foo\.txt/, '改动应仍在工作区,留给下一轮 loop 继续');
});

test('done checklist 全部勾完:走正常成功路径,自动 commit + 归档', async () => {
  const proj = await setupProject({
    scope: 'web',
    autoCommit: true,
    initialFiles: { 'src/foo.txt': 'old' },
    rows: [
      {
        id: 8, desc: '迁移子任务', scope: 'web', priority: '中', status: '进行中',
        note: '',
        checklist: JSON.stringify([
          { text: 'A 步', done: true },
          { text: 'B 步', done: true },
        ]),
        question: '', risk: '', ctime: '2026-05-20T10:00:00Z', ftime: '',
      },
    ],
  });
  fs.writeFileSync(path.join(proj, 'src/foo.txt'), 'new');
  await doneCmd(proj, ['8', '完成']);
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const archived = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 0, '应已归档');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].status, '已完成');
});
