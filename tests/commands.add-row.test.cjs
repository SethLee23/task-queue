'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createBlankWorkbook,
  readRows,
  SHEET_IN_PROGRESS,
} = require('../lib/workbook.cjs');
const addRowCmd = require('../commands/add-row.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-add-row-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function setupProject() {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  fs.writeFileSync(
    path.join(proj, '.tasks', 'project.config.js'),
    `module.exports = {
      scopes: { web: { dir: 'web', autoCommit: true }, core: { dir: '.', autoCommit: false } },
      buildCommands: { web: 'true', core: 'true' },
      versionFiles: { web: 'web/package.json', core: 'package.json' },
      changelogFiles: { web: 'web/README.md', core: 'CHANGELOG.md' },
      sameDayShareVersion: true,
      inferModule: () => '路由管理',
      commitMessage: ({ scope, module, desc, version }) =>
        \`T#0000 \${scope}## \${version}\\n\\n【\${module}】\${desc}；\`,
      autoPush: false,
    };`,
  );
  await createBlankWorkbook(path.join(proj, '.tasks', 'tasks.xlsx'));
  return proj;
}

test('add-row 成功路径写入待办行', async () => {
  const proj = await setupProject();
  await addRowCmd(proj, ['加一个登录按钮', 'web', '高', '紧急上线']);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].desc, '加一个登录按钮');
  assert.equal(rows[0].scope, 'web');
  assert.equal(rows[0].priority, '高');
  assert.equal(rows[0].status, '待办');
  assert.equal(rows[0].note, '紧急上线');
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].ftime, '');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(String(rows[0].ctime)), 'ctime 应是 ISO 时间戳');
});

test('add-row priority 缺省为 "中"，note 缺省为空', async () => {
  const proj = await setupProject();
  await addRowCmd(proj, ['修改主页', 'web']);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].priority, '中');
  assert.equal(rows[0].note, '');
});

test('add-row scope 非法时抛错', async () => {
  const proj = await setupProject();
  await assert.rejects(() => addRowCmd(proj, ['x', 'invalid']), /scope.*invalid/);
});

test('add-row priority 非法时抛错', async () => {
  const proj = await setupProject();
  await assert.rejects(() => addRowCmd(proj, ['x', 'web', '紧急']), /priority/);
});

test('add-row 缺 desc 抛错', async () => {
  const proj = await setupProject();
  await assert.rejects(() => addRowCmd(proj, []), /desc/);
});

test('add-row 缺 scope 抛错', async () => {
  const proj = await setupProject();
  await assert.rejects(() => addRowCmd(proj, ['x']), /scope/);
});

test('add-row 多次追加 — 行依次写入且 id 自增', async () => {
  const proj = await setupProject();
  await addRowCmd(proj, ['a', 'web']);
  await addRowCmd(proj, ['b', 'core', '低']);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].desc, 'a');
  assert.equal(rows[0].id, 1);
  assert.equal(rows[1].desc, 'b');
  assert.equal(rows[1].id, 2);
  assert.equal(rows[1].priority, '低');
});
