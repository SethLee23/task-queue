# 已完成任务「回复重开」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dashboard 上已完成/已跳过的归档任务能「添加回复」并带着完整 note 历史重新进入 TODO，供 loop 重新处理。

**Architecture:** 方案 A——独立 `commands/reopen.cjs`（`reopenCore` + CLI），复用 `reply.cjs` 的 `demoteLatestTags`/`getReplierName`；新增 dashboard 端点 `POST /reopen`；web 加「回复重开」弹窗与按钮。归档→进行中的搬运在单个 `withWorkbook` 事务内完成（镜像 `mark-done` 的反向）。不走状态机 `canTransition`（DONE/SKIPPED 是终态），显式校验状态。

**Tech Stack:** Node.js CommonJS `.cjs`、`node:test`、exceljs（经 `lib/workbook.cjs`）、原生 DOM（web/app.js）。

依据：`docs/specs/2026-06-02-reopen-completed-task-design.md`。

运行测试：`node --test tests/<file>.cjs`（单文件）；全量用显式 glob `node --test tests/*.test.cjs`（目录模式会被非测试文件绊住）。已知 2 个与本功能无关的预存失败：`GET / 返回 index.html 内容`、`COLUMNS 11 列…`。

---

## 文件结构

| 文件 | 类型 | 职责 |
|---|---|---|
| `commands/reply.cjs` | 改 | 把 `demoteLatestTags`、`getReplierName` 挂到 `module.exports` 供复用（现为模块私有） |
| `commands/reopen.cjs` | 新增 | `reopenCore(projectRoot, {id, reply})` + CLI 入口 |
| `tasks.cjs` | 改 | `KNOWN_COMMANDS` 加 `'reopen'` |
| `commands/dashboard-server.cjs` | 改 | `handleReopen` + 路由 `POST /api/projects/:slug/reopen`；`handleGetHistory` 扩到也含 SKIPPED（带 status 字段） |
| `web/app.js` | 改 | `openReopenModal/submitReopen/renderReopenModal`；`renderCard` done 组卡片加「回复重开」按钮 |
| `tests/commands.reopen.test.cjs` | 新增 | reopenCore 单测 |
| `tests/dashboard-server.reopen.test.cjs` | 新增 | reopen 端点 + history 含 skipped 单测 |

---

## Task 1: reply.cjs 导出 helper + reopenCore + CLI + 注册

**Files:**
- Modify: `commands/reply.cjs`（末尾 `module.exports` 区）
- Create: `commands/reopen.cjs`
- Modify: `tasks.cjs`（`KNOWN_COMMANDS`）
- Test: `tests/commands.reopen.test.cjs`

- [ ] **Step 1: 导出 reply.cjs 的两个 helper**

在 `commands/reply.cjs` 末尾（现有 `module.exports = replyCli; module.exports.replyCore = replyCore;` 之后）追加：
```javascript
module.exports.demoteLatestTags = demoteLatestTags;
module.exports.getReplierName = getReplierName;
```

- [ ] **Step 2: 写失败测试 `tests/commands.reopen.test.cjs`**

参考 `tests/commands.mark-done.test.cjs` 的建表方式（用 `lib/workbook.cjs` 写一个含进行中表 + 归档表的 xlsx）。完整测试：

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { reopenCore } = require('../commands/reopen.cjs');
const { writeRows, readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');

function mkProject(archivedRows, inProgressRows = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-'));
  fs.mkdirSync(path.join(root, '.tasks'), { recursive: true });
  const xlsx = path.join(root, '.tasks', 'tasks.xlsx');
  return writeRows(xlsx, { [SHEET_IN_PROGRESS]: inProgressRows, [SHEET_ARCHIVED]: archivedRows })
    .then(() => ({ root, xlsx }));
}

function doneRow(over = {}) {
  return {
    id: 42, desc: '修复登录', scope: 'web', priority: '中', status: STATES.DONE,
    note: '[done 2026-06-01 10:00]\ncommit abc123\n说明: 修好了', question: '', risk: '',
    ctime: '2026-06-01T00:00:00.000Z', ftime: '2026-06-01T02:00:00.000Z', model: '', tags: '', checklist: '',
    ...over,
  };
}

test('DONE 任务重开 → 搬到进行中、status=TODO、ftime 清空、id 不变', async () => {
  const { root, xlsx } = await mkProject([doneRow()]);
  const r = await reopenCore(root, { id: 42, reply: '还要支持记住密码' });
  assert.equal(r.id, 42);
  assert.equal(r.status, STATES.TODO);
  assert.equal(r.fromStatus, STATES.DONE);
  assert.equal(r.reopened, true);
  const arch = await readRows(xlsx, SHEET_ARCHIVED);
  assert.equal(arch.find(x => String(x.id) === '42'), undefined, '归档表不应再有 42');
  const inp = await readRows(xlsx, SHEET_IN_PROGRESS);
  const moved = inp.find(x => String(x.id) === '42');
  assert.ok(moved, '进行中表应有 42');
  assert.equal(moved.status, STATES.TODO);
  assert.ok(!moved.ftime, 'ftime 应清空');
});

test('SKIPPED 任务重开 → 同样成功', async () => {
  const { root, xlsx } = await mkProject([doneRow({ id: 7, status: STATES.SKIPPED, note: '跳过原因' })]);
  const r = await reopenCore(root, { id: 7, reply: '其实还是要做' });
  assert.equal(r.status, STATES.TODO);
  assert.equal(r.fromStatus, STATES.SKIPPED);
  const inp = await readRows(xlsx, SHEET_IN_PROGRESS);
  assert.ok(inp.find(x => String(x.id) === '7'));
});

test('note：旧 LATEST 降级、新块为唯一 LATEST、原 done 块保留', async () => {
  const prev = '[张三 回复 LATEST 2026-06-01 09:00] 老回复\n---\n[done 2026-06-01 10:00]\n说明: ok';
  const { root, xlsx } = await mkProject([doneRow({ note: prev })]);
  await reopenCore(root, { id: 42, reply: '新指令' });
  const inp = await readRows(xlsx, SHEET_IN_PROGRESS);
  const note = inp.find(x => String(x.id) === '42').note;
  const latestCount = (note.match(/回复 LATEST/g) || []).length;
  assert.equal(latestCount, 1, '只应有 1 个 LATEST');
  assert.ok(note.includes('回复 OBSOLETE'), '旧 LATEST 应被降级为 OBSOLETE');
  assert.ok(note.includes('新指令'), '应含新回复');
  assert.ok(note.includes('[done 2026-06-01 10:00]'), '原 done 块应保留');
  assert.ok(note.indexOf('新指令') < note.indexOf('[done'), '新块应在顶部');
});

test('reply 为空 → 抛错', async () => {
  const { root } = await mkProject([doneRow()]);
  await assert.rejects(() => reopenCore(root, { id: 42, reply: '   ' }), /回复内容不能为空|reply/);
});

test('id 不在归档表 → 抛错', async () => {
  const { root } = await mkProject([doneRow()]);
  await assert.rejects(() => reopenCore(root, { id: 999, reply: 'x' }), /未找到/);
});

test('归档表里状态非 DONE/SKIPPED → 抛错', async () => {
  const { root } = await mkProject([doneRow({ status: STATES.TODO })]);
  await assert.rejects(() => reopenCore(root, { id: 42, reply: 'x' }), /仅适用|DONE|SKIPPED|状态/);
});
```

注意：`lib/workbook.cjs` 的导出函数名（`writeRows`/`readRows`/`SHEET_*`）以实际为准——动手前先 `grep -n "module.exports" lib/workbook.cjs` 与 `grep -nE "writeRows|readRows" tests/commands.mark-done.test.cjs` 确认建表辅助的真实用法，按其签名调整 `mkProject`。

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test tests/commands.reopen.test.cjs`
Expected: FAIL，`Cannot find module '../commands/reopen.cjs'`

- [ ] **Step 4: 实现 `commands/reopen.cjs`**

```javascript
// commands/reopen.cjs — 已归档(完成/跳过)任务追加回复并重开为 TODO，带回完整 note 历史。
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED, colIndex,
} = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');
const { localTimestamp } = require('../lib/datetime.cjs');
const { demoteLatestTags, getReplierName } = require('./reply.cjs');

/**
 * 核心实现，供 CLI 与 dashboard server 共用。
 *
 * 行为：在归档表找 id（状态须 ∈ {DONE, SKIPPED}）→ 回复以 `[<名字> 回复 LATEST ts] ...` 块写到 note 顶部
 * （旧 LATEST 降级为 OBSOLETE，原 done 块保留在 --- 之下）→ 行从归档表搬到进行中表，status=TODO，ftime 清空，
 * id/ctime/scope/priority/desc/tags 等不变。这是一次有意的「重开」，不走 canTransition（终态在状态机里无出边）。
 *
 * @param {string} projectRoot
 * @param {{ id: number|string, reply: string }} fields
 * @returns {Promise<{ id: number|string, status: string, fromStatus: string, reopened: boolean }>}
 */
async function reopenCore(projectRoot, fields) {
  const { id } = fields;
  if (id == null || id === '') throw new Error('reopen 需要 id 参数');
  const replyText = String(fields.reply || '').trim();
  if (!replyText) throw new Error('回复内容不能为空');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const archived = await readRows(xlsxPath, SHEET_ARCHIVED);
  const target = archived.find(r => String(r.id) === String(id));
  if (!target) throw new Error(`未找到 id=${id} 的已归档任务`);

  if (target.status !== STATES.DONE && target.status !== STATES.SKIPPED) {
    throw new Error(`reopen 仅适用于 已完成/跳过 状态，当前: ${target.status}`);
  }

  const oldNote = demoteLatestTags(String(target.note || ''));
  const ts = localTimestamp();
  const block = `[${getReplierName()} 回复 LATEST ${ts}] ${replyText}`;
  const newNote = oldNote ? `${block}\n---\n${oldNote}` : block;
  const fromStatus = target.status;

  await withWorkbook(xlsxPath, async wb => {
    const wsArch = wb.getWorksheet(SHEET_ARCHIVED);
    const wsIn = wb.getWorksheet(SHEET_IN_PROGRESS);
    const { _rowNumber, ...cleanRow } = target;
    cleanRow.status = STATES.TODO;
    cleanRow.note = newNote;
    cleanRow.ftime = '';
    wsIn.addRow(cleanRow);
    wsArch.spliceRows(_rowNumber, 1);
  });

  new Logger(projectRoot).info(
    `task #${target.id} reopen (from ${fromStatus}): ${replyText.slice(0, 60)}`,
  );

  return { id: target.id, status: STATES.TODO, fromStatus, reopened: true };
}

/**
 * CLI 入口: args = [id, reply]
 * @param {string} projectRoot
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function reopenCli(projectRoot, args) {
  const [idArg, replyArg] = args;
  const result = await reopenCore(projectRoot, { id: idArg, reply: replyArg });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = reopenCli;
module.exports.reopenCore = reopenCore;
```

注意：`cleanRow` 的字段顺序须与 `wsIn.addRow` 期望一致——`mark-done.cjs` 用同样的 `const { _rowNumber, ...cleanRow } = target; wsArch.addRow(cleanRow);` 反向搬运成功，本任务镜像它（addRow 到 IN_PROGRESS）。若 `addRow(对象)` 在本 repo 依赖列顺序，参照 `mark-done.cjs` 的写法即可（它已验证可行）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/commands.reopen.test.cjs`
Expected: PASS（6 个 test）

- [ ] **Step 6: 注册 CLI 命令**

`tasks.cjs` 的 `KNOWN_COMMANDS` 数组追加 `'reopen'`（与 `'reply'`、`'mark-done'` 同级；reopen 需要 project-root，故**不要**加进 `COMMANDS_NOT_REQUIRING_PROJECT_ROOT`）。

- [ ] **Step 7: 冒烟 + 提交**

Run: `node tasks.cjs reopen` → 应报 `命令 reopen 需要 <project-root> 参数`（退出码 2），证明已注册。
```bash
git add commands/reply.cjs commands/reopen.cjs tasks.cjs tests/commands.reopen.test.cjs
git commit -m "feat: reopen 命令 — 已完成/跳过任务追加回复并重开为 TODO

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
仅显式 add 这 4 个文件（禁 -A）。

---

## Task 2: dashboard /reopen 端点 + history 含 skipped

**Files:**
- Modify: `commands/dashboard-server.cjs`（加 `handleReopen` + 路由；`handleGetHistory` 过滤改为含 SKIPPED）
- Test: `tests/dashboard-server.reopen.test.cjs`

- [ ] **Step 1: 写失败测试 `tests/dashboard-server.reopen.test.cjs`**

参考 `tests/dashboard-server.mark-done.test.cjs` 的起服务方式（`startServer({port:0})` + `TASK_QUEUE_REGISTRY_PATH` + 建项目 xlsx）。完整测试：

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-reopen-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { writeRows, readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');

let inst;
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

async function mkProject(archivedRows) {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'), { recursive: true });
  await writeRows(path.join(proj, '.tasks', 'tasks.xlsx'),
    { [SHEET_IN_PROGRESS]: [], [SHEET_ARCHIVED]: archivedRows });
  return proj;
}
function doneRow(over = {}) {
  return { id: 5, desc: 'x', scope: 'web', priority: '中', status: STATES.DONE,
    note: '[done] ok', question: '', risk: '', ctime: '2026-06-01T00:00:00.000Z',
    ftime: '2026-06-02T00:00:00.000Z', model: '', tags: '', checklist: '', ...over };
}

test('POST /reopen 正常 → 200 且任务进 TODO', async () => {
  const proj = await mkProject([doneRow()]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 5, reply: '继续做' }),
  });
  assert.equal(r.status, 200);
  const inp = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inp.find(x => String(x.id) === '5').status, STATES.TODO);
});

test('POST /reopen reply 空 → 400', async () => {
  const proj = await mkProject([doneRow()]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 5, reply: '  ' }),
  });
  assert.equal(r.status, 400);
});

test('POST /reopen id 不存在 → 4xx', async () => {
  const proj = await mkProject([doneRow()]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 999, reply: 'x' }),
  });
  assert.ok(r.status >= 400 && r.status < 500, `应 4xx，实际 ${r.status}`);
});

test('POST /reopen slug 非法 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/Bad_Slug/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 5, reply: 'x' }),
  });
  assert.equal(r.status, 400);
});

test('GET /history 也返回 SKIPPED 任务', async () => {
  const proj = await mkProject([doneRow({ id: 8, status: STATES.SKIPPED })]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/history?days=365`);
  const body = await r.json();
  assert.ok(body.items.some(it => String(it.id) === '8' && it.status === STATES.SKIPPED),
    'history 应含 skipped 项且带 status');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/dashboard-server.reopen.test.cjs`
Expected: FAIL（404/找不到路由 → reopen 返回非 200；history skipped 断言失败）

- [ ] **Step 3: 加 `handleReopen`（紧跟 `handleReply` 之后）**

在 `commands/dashboard-server.cjs` 顶部 require 区，`replyCore` 那行附近加：
```javascript
const { reopenCore } = require('./reopen.cjs');
```
在 `handleReply` 函数之后插入：
```javascript
/**
 * 处理 POST /api/projects/:slug/reopen
 * body: { id, reply } 把已完成/跳过的归档任务追加回复并重开为 todo。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleReopen(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body || body.id == null) return sendJson(res, 400, { error: 'id 必填' });
  if (!body.reply || !String(body.reply).trim()) {
    return sendJson(res, 400, { error: 'reply 内容不能为空' });
  }

  try {
    const result = await reopenCore(entry.root, { id: body.id, reply: String(body.reply) });
    sendJson(res, 200, { ok: true, task: result });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
}
```

- [ ] **Step 4: 注册路由（紧跟 reply 路由 L1139-1142 之后）**

```javascript
  const reopenM = pathname.match(/^\/api\/projects\/([^/]+)\/reopen$/);
  if (reopenM && req.method === 'POST') {
    handleReopen(req, res, reopenM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }
```

- [ ] **Step 5: 扩 `handleGetHistory` 也含 SKIPPED**

在 `handleGetHistory` 里，把过滤行
```javascript
    if (row.status !== STATES.DONE || !row.ftime) continue;
```
改为
```javascript
    if ((row.status !== STATES.DONE && row.status !== STATES.SKIPPED) || !row.ftime) continue;
```
并确保 `pickFields(row, TASK_PICK_FIELDS)` 带上 `status`——若 `TASK_PICK_FIELDS` 不含 `status`，在该函数内 `picked.status = row.status;`（紧跟 `picked.ftime = ...` 那行后）。
（SKIPPED 行可能没有 `ftime`；若希望跳过项也出现在历史，进一步把判断放宽为：DONE 必须有 ftime，SKIPPED 用 `ftime || ctime` 兜底排序。最小实现：`const sortT = row.ftime || row.ctime;` 用 `sortT` 算 `d`/`t`，过滤与排序都用它。动手时按该文件现有 `d`/`t` 变量改造，保持倒序不变。）

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `node --test tests/dashboard-server.reopen.test.cjs`（5 个 test 全过）
Run: `node --test tests/dashboard-server.loop-command.test.cjs tests/dashboard-server.mark-done.test.cjs`（确认未破坏既有 dashboard 测试）

- [ ] **Step 7: 提交**

```bash
git add commands/dashboard-server.cjs tests/dashboard-server.reopen.test.cjs
git commit -m "feat: dashboard /reopen 端点 + history 含 skipped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
仅这 2 个文件（禁 -A）。

---

## Task 3: web UI — 回复重开弹窗 + 卡片按钮

**Files:**
- Modify: `web/app.js`（新增 reopen 弹窗三函数；`renderCard` done 组加按钮）

本任务是浏览器 DOM 代码，无单测框架覆盖；验证以「启动 dashboard 手动点」为准。动手前先读 `web/app.js` 的
`openReplyModal`/`closeReplyModal`/`submitReply`/`renderReplyModal`（约 L1845-2010）与 `renderCard`（约 L757+）
确认 `el()`、`postAction()`、`bindImeSafeInput()`、`refreshProjects()`、`state` 的真实用法，照其风格写。

- [ ] **Step 1: 加 reopen 弹窗三函数（放在 `renderReplyModal` 之后）**

```javascript
function openReopenModal(task) {
  state.reopenModal = {
    id: task.id,
    desc: task.desc || '',
    note: task.note || '',
    reply: '',
    error: '',
    submitting: false,
  };
  renderReopenModal();
}

function closeReopenModal() {
  state.reopenModal = null;
  renderReopenModal();
}

async function submitReopen() {
  const m = state.reopenModal;
  if (!m || m.submitting) return;
  if (!m.reply.trim()) { m.error = '回复内容不能为空'; renderReopenModal(); return; }
  m.submitting = true; m.error = ''; renderReopenModal();

  const r = await postAction(`/api/projects/${state.selectedSlug}/reopen`, {
    id: m.id, reply: m.reply.trim(),
  });
  if (r.ok) {
    closeReopenModal();
    if (state.historyModal) await openHistoryModal(state.historyModal.days); // 历史弹窗里重开后刷新列表
    await refreshProjects();
  } else {
    m.submitting = false;
    m.error = r.body?.error || `失败 (${r.status})`;
    renderReopenModal();
  }
}

function renderReopenModal() {
  const existing = document.getElementById('reopen-modal');
  if (existing) existing.remove();
  if (!state.reopenModal) return;
  const m = state.reopenModal;

  const replyInput = el('textarea', {
    className: 'modal-input', rows: 5,
    placeholder: '回复内容（提交后任务带着完整历史重新进入待办，交给 loop 重做）',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
  });
  replyInput.value = m.reply || '';
  bindImeSafeInput(replyInput, v => { m.reply = v; });

  const modal = el('div', {
    id: 'reopen-modal', className: 'modal-backdrop',
    onclick: e => { if (e.target.id === 'reopen-modal') closeReopenModal(); },
  },
    el('div', { className: 'modal' },
      el('div', { className: 'modal-title' }, `回复重开 #${m.id}`),
      el('div', { className: 'modal-desc' }, m.desc),
      replyInput,
      m.error ? el('div', { className: 'modal-error' }, m.error) : null,
      el('div', { className: 'modal-actions' },
        el('button', { className: 'btn', onclick: closeReopenModal }, '取消'),
        el('button', {
          className: 'btn primary', disabled: m.submitting,
          onclick: submitReopen,
        }, m.submitting ? '提交中…' : '重开为待办'),
      ),
    ),
  );
  document.body.appendChild(modal);
}
```
（`modal-desc` class 若不存在，沿用 reply 弹窗里展示 desc 的同款 class；以 `renderReplyModal` 实际用的为准。）

- [ ] **Step 2: 在 `renderCard` 的 done 组加「回复重开」按钮**

在 `renderCard(t, group)` 里，找到按 group 追加动作按钮的区域（todo/blocked/review 已有 `card-actions`）。
为 `group === 'done'` 增加一个动作行：
```javascript
  if (group === 'done') {
    children.push(el('div', { className: 'card-actions' },
      el('button', {
        className: 'btn primary',
        onclick: (e) => { e.stopPropagation(); openReopenModal(t); },
      }, '回复重开'),
    ));
  }
```
放在 done 组现有渲染（note 内联那段）之后、卡片 children 收尾之前。`e.stopPropagation()` 防止触发卡片本身的点击展开（参照该文件里 `skipTask` 按钮同样的处理）。

说明：历史弹窗用 `renderCard(t, 'done')` 渲染，故此按钮自动出现在「查看历史」里；Task 2 已让 history 含 SKIPPED 项，它们同样以 'done' 组渲染 → 也带按钮。底部「今日完成」区如果也走 `renderCard(_, 'done')`，按钮一并出现；若「今日完成」是另一套精简渲染（动手时确认），在那里同样加一个 `openReopenModal(t)` 小按钮。

- [ ] **Step 3: 手动验证**

启动面板（用项目既有方式，如 `node tasks.cjs dashboard`，或 `/run` skill），在浏览器：
1. 打开「查看历史」→ 已完成任务卡片有「回复重开」按钮。
2. 点按钮 → 弹窗出现 → 填回复 → 「重开为待办」。
3. 确认：弹窗关闭、该任务从历史/完成区消失、出现在「待办」列；点开它 note 顶部是新 LATEST 回复块、下面保留原 done 块。
4. 空回复点提交 → 显示「回复内容不能为空」，不提交。

- [ ] **Step 4: 提交**

```bash
git add web/app.js
git commit -m "feat: dashboard 已完成/历史任务加「回复重开」按钮与弹窗

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
仅 `web/app.js`（禁 -A）。

---

## 自审记录

- **Spec 覆盖**：reopenCore 行为(Task1 Step4 + 测试 1-6)、helper 导出(Task1 Step1)、CLI+注册(Task1 Step6-7)、/reopen 端点(Task2 Step3-4)、DONE+SKIPPED 支持(Task1 测试 1/2 + Task2 history skipped)、dashboard 两处按钮(Task3 Step2，今日完成+历史均经 renderCard('done'))、note 历史保留+LATEST 降级(Task1 测试 3)、不走 canTransition(Task1 Step4 显式校验)、ftime 清空+id 不变(Task1 测试 1)、loop 衔接(无需改 loop-prompt，设计已述)、错误处理(空 reply/缺 id/状态非法 — Task1 测试 4-6 + Task2 测试 2-4) — 全部有对应任务。
- **占位符**：无 TBD/TODO；每个代码步骤含完整代码。两处「动手前先 grep/读确认」是针对**既有文件的真实 API 名**（workbook 导出、web helper），不是逻辑占位——给出了确认方法与参照文件。
- **类型一致**：`reopenCore(root,{id,reply})` 返回 `{id,status,fromStatus,reopened}` 在 Task1 实现与 Task2 端点/测试一致；`demoteLatestTags`/`getReplierName` 在 Task1 Step1 导出、Step4 引用一致；端点 body `{id,reply}` 在 Task2 与 Task3 `submitReopen` 一致；状态常量统一用 `STATES.DONE/SKIPPED/TODO`。
