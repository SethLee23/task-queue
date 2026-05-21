# task-queue Dashboard v0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 task-queue skill 加本地 Web 控制面板，聚合所有接入项目的实时状态，支持 skip / 改优先级 / pause / resume 简单写操作。

**Architecture:** 浏览器 5s 轮询 `127.0.0.1:5732`，后端 `node:http` 每次请求 lazy 读 `~/.task-queue/projects.json` 注册表和各项目 `.tasks/tasks.xlsx`。心跳由 `claim/done/review/block/next` 命令副作用触发，5s 内反映 loop 进度。写操作和 loop 共享自实现 mkdir 文件锁。

**Tech Stack:** Node.js 18+、`node:http`、`node:test`、已有 `exceljs`；前端单 HTML + 原生 JS 零编译；零新依赖。

**Spec:** `docs/specs/2026-05-21-dashboard-design.md`

---

## 文件结构总览

### 新建

```
commands/
  dashboard.cjs              # 入口 + 子命令派发（serve/register/unregister/list）
  dashboard-server.cjs       # http 服务（导出 startServer）
  heartbeat.cjs              # heartbeat 兜底子命令（手工触发）
lib/
  lock.cjs                   # mkdir 原子锁（withLock + acquireLock/releaseLock）
  registry.cjs               # ~/.task-queue/projects.json 读写
  heartbeat.cjs              # writeHeartbeat / readHeartbeat
  slug.cjs                   # rootToSlug 工具（注册和 API 共用）
  paused.cjs                 # loop-paused flag 读写
web/
  index.html
  app.js
  styles.css
tests/
  lib.lock.test.cjs
  lib.registry.test.cjs
  lib.heartbeat.test.cjs
  lib.slug.test.cjs
  lib.paused.test.cjs
  commands.dashboard-register.test.cjs
  commands.dashboard-unregister.test.cjs
  commands.dashboard-list.test.cjs
  commands.heartbeat.test.cjs
  dashboard-server.api.test.cjs        # GET /api/projects 和详情
  dashboard-server.write.test.cjs      # POST skip/priority/pause/resume
docs/plans/
  2026-05-21-task-queue-dashboard.md   # 本文件
```

### 改动

```
lib/workbook.cjs                       # withWorkbook 外层套 lock
commands/init-write.cjs                # 末尾自动 registry.add
commands/claim.cjs                     # 成功后 writeHeartbeat(executing)
commands/done.cjs                      # 归档/转 review 后 writeHeartbeat(idle)
commands/review.cjs                    # 成功后 writeHeartbeat(idle)
commands/block.cjs                     # 成功后 writeHeartbeat(idle)
commands/next.cjs                      # 返回 null 时 writeHeartbeat(sleeping)
loop-prompt.md                         # Step 0.5：检查 loop-paused
tasks.cjs                              # KNOWN_COMMANDS 注册 dashboard / heartbeat
SKILL.md                               # 喊词表 + 子命令一览
```

---

## Task 1: lib/lock.cjs — 自旋 mkdir 文件锁

**Files:**
- Create: `~/.claude/skills/task-queue/lib/lock.cjs`
- Create: `~/.claude/skills/task-queue/tests/lib.lock.test.cjs`

**约束**：

- 用 `fs.mkdirSync(lockDir)` 作原子获取（存在则 EEXIST）
- lockDir 内写 `info.json = { pid, ts }`，stale 判定 = 距 ts > 30s
- 自旋等待最多 5s，间隔 100ms；超时抛 `LockTimeoutError`
- 支持 `withLock(lockDir, fn)` 高阶函数封装

- [ ] **Step 1: 写失败测试**

写到 `tests/lib.lock.test.cjs`：

```javascript
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withLock, acquireLock, releaseLock, LockTimeoutError } = require('../lib/lock.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('withLock 串行执行 — 第二个等第一个释放', async () => {
  const lockDir = path.join(tmpDir, 'lock1');
  const order = [];
  const p1 = withLock(lockDir, async () => {
    order.push('a-start');
    await new Promise(r => setTimeout(r, 80));
    order.push('a-end');
  });
  const p2 = withLock(lockDir, async () => {
    order.push('b-start');
    order.push('b-end');
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('withLock 释放锁即使 fn 抛错', async () => {
  const lockDir = path.join(tmpDir, 'lock2');
  await assert.rejects(() => withLock(lockDir, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lockDir), false, '锁目录应被释放');
});

test('acquireLock 自旋超过 5s 抛 LockTimeoutError', async () => {
  const lockDir = path.join(tmpDir, 'lock3');
  await acquireLock(lockDir);
  const t0 = Date.now();
  await assert.rejects(
    () => acquireLock(lockDir, { timeoutMs: 300, intervalMs: 50 }),
    err => err instanceof LockTimeoutError,
  );
  assert.ok(Date.now() - t0 >= 250, '应等待至少 ~timeoutMs');
  await releaseLock(lockDir);
});

test('stale 锁（info.ts > 30s 前）会被自动接管', async () => {
  const lockDir = path.join(tmpDir, 'lock4');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({
    pid: 99999, ts: new Date(Date.now() - 60000).toISOString(),
  }));
  // stale 锁应被接管，acquire 立即成功
  await acquireLock(lockDir, { timeoutMs: 200, intervalMs: 50 });
  await releaseLock(lockDir);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.lock.test.cjs
```

Expected: 全部 FAIL，找不到 `../lib/lock.cjs`。

- [ ] **Step 3: 实现 lib/lock.cjs**

写到 `~/.claude/skills/task-queue/lib/lock.cjs`：

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STALE_THRESHOLD_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 100;

class LockTimeoutError extends Error {
  constructor(lockDir, timeoutMs) {
    super(`Lock timeout after ${timeoutMs}ms on ${lockDir}`);
    this.name = 'LockTimeoutError';
    this.lockDir = lockDir;
  }
}

function tryClaim(lockDir) {
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'info.json'),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

function isStale(lockDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8'));
    const age = Date.now() - new Date(info.ts).getTime();
    return age > STALE_THRESHOLD_MS;
  } catch (_) {
    // info.json 损坏或缺失，视为 stale
    return true;
  }
}

function forceRelease(lockDir) {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) {}
}

async function acquireLock(lockDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (tryClaim(lockDir)) return;
    if (isStale(lockDir)) {
      forceRelease(lockDir);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(lockDir, timeoutMs);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

async function releaseLock(lockDir) {
  forceRelease(lockDir);
}

async function withLock(lockDir, fn, opts) {
  await acquireLock(lockDir, opts);
  try {
    return await fn();
  } finally {
    await releaseLock(lockDir);
  }
}

module.exports = { withLock, acquireLock, releaseLock, LockTimeoutError };
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.lock.test.cjs
```

Expected: 4 tests pass。

- [ ] **Step 5: 跑全套回归**

```bash
cd ~/.claude/skills/task-queue && node --test tests/*.test.cjs
```

Expected: 既有测试 + 新 4 个 = 70 个 pass。

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/lock.cjs tests/lib.lock.test.cjs
git commit -m "task-queue dashboard: lib/lock.cjs mkdir 原子锁（自旋 5s + stale 30s 接管）"
```

---

## Task 2: lib/workbook.cjs 套 lock

**Files:**
- Modify: `~/.claude/skills/task-queue/lib/workbook.cjs:67-95`

**约束**：

- 仅 `withWorkbook` 套锁（读路径 `readRows` 不加锁，避免读阻塞）
- lock 目录 = `<dirname(xlsxPath)>/run/.xlsx.lock`
- 既有 backup + sanity check 逻辑保留

- [ ] **Step 1: 写测试 — 并发 withWorkbook 串行化**

追加到 `tests/lib.workbook.test.cjs`（若不存在则创建）：

```javascript
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS,
} = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbook-lock-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('withWorkbook 并发写串行化 — 两次 addRow 都到位', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);

  await Promise.all([
    withWorkbook(xlsx, async wb => {
      wb.getWorksheet(SHEET_IN_PROGRESS).addRow({ id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办' });
    }),
    withWorkbook(xlsx, async wb => {
      wb.getWorksheet(SHEET_IN_PROGRESS).addRow({ id: 2, desc: 'b', scope: 'web', priority: '中', status: '待办' });
    }),
  ]);

  const rows = await readRows(xlsx, SHEET_IN_PROGRESS);
  assert.equal(rows.length, 2);
  const ids = rows.map(r => String(r.id)).sort();
  assert.deepEqual(ids, ['1', '2'], '两行都应入表，无丢失');
});

test('withWorkbook 自动创建 run/ 子目录用于放锁', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);

  await withWorkbook(xlsx, async wb => {
    wb.getWorksheet(SHEET_IN_PROGRESS).addRow({ id: 1, desc: 'x', scope: 'web', priority: '中', status: '待办' });
  });

  assert.equal(fs.existsSync(path.join(proj, '.tasks', 'run')), true);
  assert.equal(fs.existsSync(path.join(proj, '.tasks', 'run', '.xlsx.lock')), false, '锁应已释放');
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.workbook.test.cjs
```

Expected: "withWorkbook 并发写串行化" 可能失败（取决于 ExcelJS 行为，但 run/ 目录不会被创建肯定失败）。

- [ ] **Step 3: 改造 withWorkbook 套 lock**

编辑 `lib/workbook.cjs`，将顶部 require 加入：

```javascript
const { withLock } = require('./lock.cjs');
```

把 `withWorkbook` 函数体替换为：

```javascript
async function withWorkbook(filePath, mutator) {
  const lockDir = path.join(path.dirname(filePath), 'run', '.xlsx.lock');
  return withLock(lockDir, async () => {
    const bakPath = filePath + '.bak';
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    _rebindColumnKeys(wb.getWorksheet(SHEET_IN_PROGRESS));
    _rebindColumnKeys(wb.getWorksheet(SHEET_ARCHIVED));

    try {
      await mutator(wb);
      await wb.xlsx.writeFile(filePath);
      const verifyWb = new ExcelJS.Workbook();
      await verifyWb.xlsx.readFile(filePath);
      if (!verifyWb.getWorksheet(SHEET_IN_PROGRESS) || !verifyWb.getWorksheet(SHEET_ARCHIVED)) {
        throw new Error('sanity check 失败：写入后 sheet 丢失');
      }
    } catch (e) {
      if (fs.existsSync(bakPath)) {
        fs.copyFileSync(bakPath, filePath);
      }
      throw e;
    }
  });
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.workbook.test.cjs tests/lib.lock.test.cjs
```

Expected: 全 pass。

- [ ] **Step 5: 跑全套回归**

```bash
cd ~/.claude/skills/task-queue && node --test tests/*.test.cjs
```

Expected: 既有 + Task 1 + Task 2 新增 = 72 个 pass，无 regression。

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/workbook.cjs tests/lib.workbook.test.cjs
git commit -m "task-queue dashboard: withWorkbook 套 mkdir 锁 + 并发串行化测试"
```

---

## Task 3: lib/slug.cjs + lib/registry.cjs — 注册表读写

**Files:**
- Create: `~/.claude/skills/task-queue/lib/slug.cjs`
- Create: `~/.claude/skills/task-queue/lib/registry.cjs`
- Create: `~/.claude/skills/task-queue/tests/lib.slug.test.cjs`
- Create: `~/.claude/skills/task-queue/tests/lib.registry.test.cjs`

**约束**：

- slug = root 末段 lowercase，非字母数字替换为 `-`，相邻 `-` 合并，碰撞时追 `-2`/`-3`
- registry 文件 = `~/.task-queue/projects.json`，schema `{ version: 1, projects: [...] }`
- add 幂等：同 root 已注册返回原条目
- 测试用 `TASK_QUEUE_REGISTRY_PATH` 环境变量重定向到 tmp 目录

- [ ] **Step 1: 写 slug 测试**

`tests/lib.slug.test.cjs`：

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rootToSlug } = require('../lib/slug.cjs');

test('普通路径取末段并 lowercase', () => {
  assert.equal(rootToSlug('/Users/seth/Desktop/para-node-4.0'), 'para-node-4-0');
});

test('末段含非字母数字字符 → 替换为 -', () => {
  assert.equal(rootToSlug('/tmp/my proj@v2!'), 'my-proj-v2');
});

test('连续非字母数字字符合并为单个 -', () => {
  assert.equal(rootToSlug('/tmp/a___b---c'), 'a-b-c');
});

test('首尾 - 被剥除', () => {
  assert.equal(rootToSlug('/tmp/--abc--'), 'abc');
});

test('全非法字符 fallback 到 "project"', () => {
  assert.equal(rootToSlug('/tmp/!!!'), 'project');
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.slug.test.cjs
```

Expected: 5 FAIL，缺 `../lib/slug.cjs`。

- [ ] **Step 3: 实现 lib/slug.cjs**

写到 `lib/slug.cjs`：

```javascript
'use strict';

const path = require('node:path');

function rootToSlug(root) {
  const base = path.basename(String(root || ''));
  const cleaned = base.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'project';
}

module.exports = { rootToSlug };
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.slug.test.cjs
```

Expected: 5 pass。

- [ ] **Step 5: 写 registry 测试**

`tests/lib.registry.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { add, remove, list, getRegistryPath } = require('../lib/registry.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

beforeEach(() => {
  try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {}
});
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('add 首次创建注册表文件并加入条目', () => {
  const entry = add('/tmp/proj-a');
  assert.equal(entry.slug, 'proj-a');
  assert.equal(entry.root, '/tmp/proj-a');
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'proj-a');
});

test('add 同 root 第二次 = 幂等（不重复，返回原条目）', () => {
  const a = add('/tmp/proj-x');
  const b = add('/tmp/proj-x');
  assert.equal(a.slug, b.slug);
  assert.equal(a.registeredAt, b.registeredAt);
  assert.equal(list().length, 1);
});

test('slug 碰撞 → 追加 -2', () => {
  add('/path1/dup');
  const second = add('/path2/dup');
  assert.equal(second.slug, 'dup-2');
});

test('remove 按 slug 删除', () => {
  add('/tmp/x');
  add('/tmp/y');
  remove('x');
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'y');
});

test('remove 不存在的 slug 不抛错（幂等）', () => {
  add('/tmp/x');
  remove('nonexistent');
  assert.equal(list().length, 1);
});

test('list 在文件不存在时返回空数组', () => {
  assert.deepEqual(list(), []);
});
```

- [ ] **Step 6: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.registry.test.cjs
```

Expected: 6 FAIL，缺 `../lib/registry.cjs`。

- [ ] **Step 7: 实现 lib/registry.cjs**

写到 `lib/registry.cjs`：

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { rootToSlug } = require('./slug.cjs');

function getRegistryPath() {
  return process.env.TASK_QUEUE_REGISTRY_PATH
    || path.join(os.homedir(), '.task-queue', 'projects.json');
}

function readRaw() {
  const p = getRegistryPath();
  if (!fs.existsSync(p)) return { version: 1, projects: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return { version: 1, projects: [] };
  }
}

function writeRaw(data) {
  const p = getRegistryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function uniqueSlug(baseSlug, existing) {
  if (!existing.some(p => p.slug === baseSlug)) return baseSlug;
  for (let i = 2; i < 100; i++) {
    const candidate = `${baseSlug}-${i}`;
    if (!existing.some(p => p.slug === candidate)) return candidate;
  }
  throw new Error(`slug 冲突过多: ${baseSlug}`);
}

function add(root) {
  const data = readRaw();
  const existing = data.projects.find(p => p.root === root);
  if (existing) return existing;
  const slug = uniqueSlug(rootToSlug(root), data.projects);
  const entry = {
    slug,
    root,
    name: path.basename(root),
    registeredAt: new Date().toISOString(),
  };
  data.projects.push(entry);
  writeRaw(data);
  return entry;
}

function remove(slug) {
  const data = readRaw();
  const before = data.projects.length;
  data.projects = data.projects.filter(p => p.slug !== slug);
  if (data.projects.length !== before) writeRaw(data);
}

function list() {
  return readRaw().projects;
}

module.exports = { add, remove, list, getRegistryPath };
```

- [ ] **Step 8: 跑测试验证通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.registry.test.cjs tests/lib.slug.test.cjs
```

Expected: 11 pass。

- [ ] **Step 9: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/slug.cjs lib/registry.cjs tests/lib.slug.test.cjs tests/lib.registry.test.cjs
git commit -m "task-queue dashboard: lib/slug + lib/registry（~/.task-queue/projects.json 读写）"
```

---

## Task 4: commands/dashboard-register.cjs + unregister + list

**Files:**
- Create: `~/.claude/skills/task-queue/commands/dashboard-register.cjs`
- Create: `~/.claude/skills/task-queue/commands/dashboard-unregister.cjs`
- Create: `~/.claude/skills/task-queue/commands/dashboard-list.cjs`
- Create: `~/.claude/skills/task-queue/tests/commands.dashboard-register.test.cjs`
- Create: `~/.claude/skills/task-queue/tests/commands.dashboard-unregister.test.cjs`
- Create: `~/.claude/skills/task-queue/tests/commands.dashboard-list.test.cjs`

**约束**：

- 三个子命令分别对应 registry.add / remove / list
- register 输出 JSON 含新条目；unregister 输出 `{ removed: slug }`；list 输出 `{ projects: [...] }`
- 这三个命令的 dispatcher 派发会通过 Task 17 的 `commands/dashboard.cjs` 完成；本 Task 仅实现 handler 函数

- [ ] **Step 1: 写 register 测试**

`tests/commands.dashboard-register.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const registerCmd = require('../commands/dashboard-register.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-cmd-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('register 输出新条目 JSON', async () => {
  const out = await captureStdout(() => registerCmd('/tmp/proj-a', []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.slug, 'proj-a');
  assert.equal(parsed.root, '/tmp/proj-a');
});

test('register 同 root 第二次返回相同条目（幂等）', async () => {
  const out1 = await captureStdout(() => registerCmd('/tmp/proj-x', []));
  const out2 = await captureStdout(() => registerCmd('/tmp/proj-x', []));
  assert.equal(JSON.parse(out1).slug, JSON.parse(out2).slug);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.dashboard-register.test.cjs
```

Expected: 2 FAIL，缺 `../commands/dashboard-register.cjs`。

- [ ] **Step 3: 实现 register**

`commands/dashboard-register.cjs`：

```javascript
'use strict';

const { add } = require('../lib/registry.cjs');

module.exports = async function dashboardRegister(projectRoot, _args) {
  if (!projectRoot) throw new Error('dashboard-register 需要 <project-root> 参数');
  const entry = add(projectRoot);
  process.stdout.write(JSON.stringify(entry) + '\n');
};
```

- [ ] **Step 4: 跑 register 测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.dashboard-register.test.cjs
```

Expected: 2 pass。

- [ ] **Step 5: 写 unregister 测试**

`tests/commands.dashboard-unregister.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const unregisterCmd = require('../commands/dashboard-unregister.cjs');
const { add, list } = require('../lib/registry.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unreg-cmd-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('unregister 删除已注册 slug 并输出 JSON', async () => {
  add('/tmp/proj-a');
  const out = await captureStdout(() => unregisterCmd(undefined, ['proj-a']));
  const parsed = JSON.parse(out);
  assert.equal(parsed.removed, 'proj-a');
  assert.equal(list().length, 0);
});

test('unregister 不存在 slug 不抛错', async () => {
  const out = await captureStdout(() => unregisterCmd(undefined, ['no-such']));
  const parsed = JSON.parse(out);
  assert.equal(parsed.removed, 'no-such');
});

test('unregister 缺 slug 参数抛错', async () => {
  await assert.rejects(() => unregisterCmd(undefined, []), /slug/);
});
```

- [ ] **Step 6: 实现 unregister**

`commands/dashboard-unregister.cjs`：

```javascript
'use strict';

const { remove } = require('../lib/registry.cjs');

module.exports = async function dashboardUnregister(_projectRoot, args) {
  const slug = args[0];
  if (!slug) throw new Error('dashboard-unregister 需要 <slug> 参数');
  remove(slug);
  process.stdout.write(JSON.stringify({ removed: slug }) + '\n');
};
```

- [ ] **Step 7: 写 list 测试**

`tests/commands.dashboard-list.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const listCmd = require('../commands/dashboard-list.cjs');
const { add } = require('../lib/registry.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-cmd-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'projects.json');

beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('list 空注册表输出 {projects:[]}', async () => {
  const out = await captureStdout(() => listCmd(undefined, []));
  assert.deepEqual(JSON.parse(out), { projects: [] });
});

test('list 输出所有已注册项目', async () => {
  add('/tmp/proj-a');
  add('/tmp/proj-b');
  const out = await captureStdout(() => listCmd(undefined, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.projects.length, 2);
});
```

- [ ] **Step 8: 实现 list**

`commands/dashboard-list.cjs`：

```javascript
'use strict';

const { list } = require('../lib/registry.cjs');

module.exports = async function dashboardList(_projectRoot, _args) {
  process.stdout.write(JSON.stringify({ projects: list() }) + '\n');
};
```

- [ ] **Step 9: 跑三个测试文件**

```bash
cd ~/.claude/skills/task-queue && node --test \
  tests/commands.dashboard-register.test.cjs \
  tests/commands.dashboard-unregister.test.cjs \
  tests/commands.dashboard-list.test.cjs
```

Expected: 8 pass。

- [ ] **Step 10: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/dashboard-register.cjs commands/dashboard-unregister.cjs commands/dashboard-list.cjs \
        tests/commands.dashboard-register.test.cjs tests/commands.dashboard-unregister.test.cjs tests/commands.dashboard-list.test.cjs
git commit -m "task-queue dashboard: 三个 registry 子命令（register/unregister/list）+ 测试"
```

---

## Task 5: init-write 末尾自动 registry.add

**Files:**
- Modify: `~/.claude/skills/task-queue/commands/init-write.cjs:176-184`
- Modify: `~/.claude/skills/task-queue/tests/commands.init-write.test.cjs`（追加测试）

**约束**：

- init-write 落盘成功后调 `registry.add(projectRoot)`
- 输出 JSON 增加 `registered: { slug, root }` 字段
- 注册失败（如磁盘满）不能让 init 失败 → try-catch + warn 日志

- [ ] **Step 1: 写测试**

追加到 `tests/commands.init-write.test.cjs`（先 Read 文件确认已有 import 列表，下面只显示新增 test）：

```javascript
test('init-write 末尾自动注册到 registry，输出含 registered 字段', async () => {
  process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, `reg-${Date.now()}.json`);
  const proj = fs.mkdtempSync(path.join(tmpDir, 'init-reg-'));
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));

  const answers = {
    autoCommitScopes: ['web'],
    scopeMapping: {
      web: { dir: 'web', versionFile: 'web/package.json', changelogFile: 'web/README.md', buildCommand: 'true' },
    },
    candidateModules: { web: ['全局'] },
    commitTemplate: { web: 'T#0000 web## __VERSION__' },
    sameDayShareVersion: true,
  };

  const out = await captureStdout(() => initWrite(proj, [JSON.stringify(answers)]));
  const parsed = JSON.parse(out);
  assert.ok(parsed.registered, 'init-write 输出应含 registered 字段');
  assert.equal(parsed.registered.root, proj);

  // 注册表里有此条目
  const { list } = require('../lib/registry.cjs');
  const slugs = list().map(p => p.root);
  assert.ok(slugs.includes(proj), 'registry 应包含该 project');
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.init-write.test.cjs
```

Expected: 新测试 FAIL（输出无 `registered` 字段）。

- [ ] **Step 3: 改 init-write.cjs**

在 `commands/init-write.cjs` 顶部 require 区加：

```javascript
const { add: registryAdd } = require('../lib/registry.cjs');
const { Logger } = require('../lib/logger.cjs');
```

把文件末尾 `process.stdout.write(JSON.stringify({...}))` 那段替换为：

```javascript
  let registered = null;
  try {
    registered = registryAdd(projectRoot);
  } catch (e) {
    new Logger(projectRoot).warn(`registry.add 失败（不阻断 init）: ${e.message}`);
  }

  process.stdout.write(JSON.stringify({
    created: {
      configFile: path.join('.tasks', 'project.config.js'),
      xlsxFile:   path.join('.tasks', 'tasks.xlsx'),
      logsDir:    path.join('.tasks', 'logs'),
    },
    gitignoreAppended: appended,
    registered: registered ? { slug: registered.slug, root: registered.root } : null,
  }, null, 2) + '\n');
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.init-write.test.cjs
```

Expected: 全部 pass（含既有测试和新增的一个）。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/init-write.cjs tests/commands.init-write.test.cjs
git commit -m "task-queue dashboard: init-write 末尾自动 registry.add（best-effort）"
```

---

## Task 6: lib/heartbeat.cjs — 心跳读写

**Files:**
- Create: `~/.claude/skills/task-queue/lib/heartbeat.cjs`
- Create: `~/.claude/skills/task-queue/tests/lib.heartbeat.test.cjs`

**约束**：

- `writeHeartbeat(projectRoot, patch)`：合并到 `.tasks/run/heartbeat.json`，自动更新 `ts`，`model` 字段读 `CLAUDE_MODEL` 环境变量（缺则保留旧值）
- `readHeartbeat(projectRoot)`：读取，文件不存在返回 null
- write 失败不抛（best-effort），返回 false
- 不引入 lock（心跳允许覆盖竞态，最后写入胜）

- [ ] **Step 1: 写测试**

`tests/lib.heartbeat.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeHeartbeat, readHeartbeat } = require('../lib/heartbeat.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  return p;
}

beforeEach(() => { process.env.CLAUDE_MODEL = 'claude-opus-4-7'; });
afterEach(() => { delete process.env.CLAUDE_MODEL; });

test('writeHeartbeat 写入并能 readHeartbeat 读回', async () => {
  const proj = mkProj();
  const ok = writeHeartbeat(proj, { phase: 'executing', currentTaskId: 12, currentTaskDesc: 'foo' });
  assert.equal(ok, true);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'executing');
  assert.equal(hb.currentTaskId, 12);
  assert.equal(hb.model, 'claude-opus-4-7');
  assert.match(hb.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('writeHeartbeat 合并 — 不在 patch 里的字段保留', async () => {
  const proj = mkProj();
  writeHeartbeat(proj, { phase: 'executing', currentTaskId: 12, lastFinishedId: 11 });
  writeHeartbeat(proj, { phase: 'idle', currentTaskId: null });
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
  assert.equal(hb.currentTaskId, null);
  assert.equal(hb.lastFinishedId, 11, 'lastFinishedId 应被保留');
});

test('CLAUDE_MODEL 缺失时保留旧 model', async () => {
  const proj = mkProj();
  writeHeartbeat(proj, { phase: 'executing' });
  delete process.env.CLAUDE_MODEL;
  writeHeartbeat(proj, { phase: 'idle' });
  const hb = readHeartbeat(proj);
  assert.equal(hb.model, 'claude-opus-4-7', 'model 应保留 first write 的值');
});

test('readHeartbeat 文件不存在返回 null', () => {
  const proj = mkProj();
  assert.equal(readHeartbeat(proj), null);
});

test('writeHeartbeat 目标目录不存在仍返回 false 不抛', () => {
  const ok = writeHeartbeat('/nonexistent/path', { phase: 'idle' });
  assert.equal(ok, false);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.heartbeat.test.cjs
```

Expected: 5 FAIL，缺 `../lib/heartbeat.cjs`。

- [ ] **Step 3: 实现 lib/heartbeat.cjs**

写到 `lib/heartbeat.cjs`：

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function heartbeatPath(projectRoot) {
  return path.join(projectRoot, '.tasks', 'run', 'heartbeat.json');
}

function readHeartbeat(projectRoot) {
  const p = heartbeatPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeHeartbeat(projectRoot, patch) {
  const p = heartbeatPath(projectRoot);
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) return false;
    const prev = readHeartbeat(projectRoot) || {};
    const next = {
      ...prev,
      ...patch,
      ts: new Date().toISOString(),
      model: process.env.CLAUDE_MODEL || prev.model || 'unknown',
    };
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { writeHeartbeat, readHeartbeat, heartbeatPath };
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.heartbeat.test.cjs
```

Expected: 5 pass。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/heartbeat.cjs tests/lib.heartbeat.test.cjs
git commit -m "task-queue dashboard: lib/heartbeat（writeHeartbeat 合并 + best-effort）"
```

---

## Task 7: claim/done/review/block/next 接入 writeHeartbeat

**Files:**
- Modify: `~/.claude/skills/task-queue/commands/claim.cjs`
- Modify: `~/.claude/skills/task-queue/commands/done.cjs`
- Modify: `~/.claude/skills/task-queue/commands/review.cjs`
- Modify: `~/.claude/skills/task-queue/commands/block.cjs`
- Modify: `~/.claude/skills/task-queue/commands/next.cjs`
- Create: `~/.claude/skills/task-queue/tests/heartbeat-integration.test.cjs`

**约束**：

- claim 成功后写 `{ phase: 'executing', currentTaskId, currentTaskDesc }`
- done 归档/转 review 后写 `{ phase: 'idle', currentTaskId: null, lastFinishedId, lastFinishedAt }`
- review/block 成功后写 `{ phase: 'idle', currentTaskId: null, lastFinishedId, lastFinishedAt }`
- next 输出 null 时写 `{ phase: 'sleeping', currentTaskId: null }`
- 失败路径不写心跳（throw 即返回，writeHeartbeat 不被调用）

- [ ] **Step 1: 写集成测试**

`tests/heartbeat-integration.test.cjs`：

```javascript
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const claimCmd = require('../commands/claim.cjs');
const doneCmd = require('../commands/done.cjs');
const reviewCmd = require('../commands/review.cjs');
const blockCmd = require('../commands/block.cjs');
const nextCmd = require('../commands/next.cjs');
const addRowCmd = require('../commands/add-row.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-int-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function setupProj() {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(proj, '.tasks', 'run'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.tasks', 'project.config.js'),
    `module.exports = {
      scopes: { web: { dir: 'web', autoCommit: false } },
      buildCommands: { web: 'true' },
      versionFiles: { web: 'web/package.json' },
      changelogFiles: { web: 'web/README.md' },
      sameDayShareVersion: true,
      inferModule: () => '全局',
      commitMessage: () => '',
      autoPush: false,
    };`,
  );
  await createBlankWorkbook(path.join(proj, '.tasks', 'tasks.xlsx'));
  return proj;
}

test('claim 后 heartbeat.phase = executing 含 currentTaskId 和 desc', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  // claim 通过 'auto' 自动取
  await captureStdout(() => claimCmd(proj, ['auto']));
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'executing');
  assert.ok(hb.currentTaskId, 'currentTaskId 应被填');
  assert.equal(hb.currentTaskDesc, 'foo');
});

test('done 后 heartbeat.phase = idle，lastFinishedId 填上', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  const claimOut = await captureStdout(() => claimCmd(proj, ['auto']));
  const id = JSON.parse(claimOut).id;
  await doneCmd(proj, [String(id)]);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
  assert.equal(hb.currentTaskId, null);
  assert.equal(hb.lastFinishedId, id);
});

test('review 后 heartbeat.phase = idle', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  const claimOut = await captureStdout(() => claimCmd(proj, ['auto']));
  const id = JSON.parse(claimOut).id;
  await reviewCmd(proj, [String(id), '需 review']);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
  assert.equal(hb.lastFinishedId, id);
});

test('block 后 heartbeat.phase = idle', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  const claimOut = await captureStdout(() => claimCmd(proj, ['auto']));
  const id = JSON.parse(claimOut).id;
  await blockCmd(proj, [String(id), '阻塞了']);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
  assert.equal(hb.lastFinishedId, id);
});

test('next 返回 null 时 heartbeat.phase = sleeping', async () => {
  const proj = await setupProj();
  await captureStdout(() => nextCmd(proj, []));
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'sleeping');
  assert.equal(hb.currentTaskId, null);
});

test('next 返回任务时不动 heartbeat（保持原状）', async () => {
  const proj = await setupProj();
  await addRowCmd(proj, ['foo', 'web', '中']);
  const out = await captureStdout(() => nextCmd(proj, []));
  assert.notEqual(out.trim(), 'null');
  const hb = readHeartbeat(proj);
  assert.equal(hb, null, 'next 拿到任务时不写 heartbeat（claim 才写）');
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/heartbeat-integration.test.cjs
```

Expected: 6 FAIL。

- [ ] **Step 3: 改 claim.cjs**

在 `commands/claim.cjs` 顶部 require 区加：

```javascript
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
```

在最后 `process.stdout.write(...)` 之前（即整个 withWorkbook 之后）加：

```javascript
  const finalId = assignedId != null ? assignedId : targetRow.id;
  writeHeartbeat(projectRoot, {
    phase: 'executing',
    currentTaskId: finalId,
    currentTaskDesc: targetRow.desc,
  });

  process.stdout.write(JSON.stringify({
    id: finalId,
    desc: targetRow.desc,
    scope: targetRow.scope,
    priority: targetRow.priority,
    note: targetRow.note,
  }) + '\n');
```

（注意把原来的 `assignedId != null ? assignedId : targetRow.id` 表达式替换为新加的 `finalId` 变量并复用）

- [ ] **Step 4: 改 done.cjs**

在 `commands/done.cjs` 顶部 require 区加：

```javascript
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
```

在 `transitionToReview` 函数末尾加：

```javascript
async function transitionToReview(xlsxPath, rowNumber, riskMsg, logger, projectRoot, taskId) {
  await setStatusAndRisk(xlsxPath, rowNumber, STATES.REVIEW, riskMsg, null);
  if (logger) logger.warn(`task → review: ${riskMsg}`);
  if (projectRoot && taskId != null) {
    writeHeartbeat(projectRoot, {
      phase: 'idle', currentTaskId: null,
      lastFinishedId: taskId, lastFinishedAt: new Date().toISOString(),
    });
  }
}
```

并把所有调用处加上 `projectRoot, target.id` 两个参数。

成功归档分支末尾（`logger.info(...task done...)` 之前）加：

```javascript
    writeHeartbeat(projectRoot, {
      phase: 'idle', currentTaskId: null,
      lastFinishedId: target.id, lastFinishedAt: new Date().toISOString(),
    });
```

无文件改动归档分支（`logger.info(...无文件改动...)` 之前）同样加心跳写入。

- [ ] **Step 5: 改 review.cjs**

在 `commands/review.cjs` 顶部 require 区加：

```javascript
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
```

在 `new Logger(projectRoot).info(...)` 之后加：

```javascript
  writeHeartbeat(projectRoot, {
    phase: 'idle', currentTaskId: null,
    lastFinishedId: target.id, lastFinishedAt: ftime,
  });
```

- [ ] **Step 6: 改 block.cjs**

先 Read `commands/block.cjs` 确认结构，参照 review.cjs 在末尾加同样的 writeHeartbeat 调用（`lastFinishedAt` 用 block 内部的 ftime/now 即可）：

```javascript
const { writeHeartbeat } = require('../lib/heartbeat.cjs');

// 在 block 主流程末尾（withWorkbook 之后）追加：
writeHeartbeat(projectRoot, {
  phase: 'idle', currentTaskId: null,
  lastFinishedId: target.id, lastFinishedAt: new Date().toISOString(),
});
```

- [ ] **Step 7: 改 next.cjs**

在 `commands/next.cjs` 顶部 require 区加：

```javascript
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
```

把 `if (todos.length === 0) { process.stdout.write('null\n'); return; }` 替换为：

```javascript
  if (todos.length === 0) {
    writeHeartbeat(projectRoot, { phase: 'sleeping', currentTaskId: null });
    process.stdout.write('null\n');
    return;
  }
```

- [ ] **Step 8: 跑集成测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/heartbeat-integration.test.cjs
```

Expected: 6 pass。

- [ ] **Step 9: 跑全套回归**

```bash
cd ~/.claude/skills/task-queue && node --test tests/*.test.cjs
```

Expected: 全 pass（约 85+ 个测试），无 regression。

- [ ] **Step 10: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/claim.cjs commands/done.cjs commands/review.cjs commands/block.cjs commands/next.cjs \
        tests/heartbeat-integration.test.cjs
git commit -m "task-queue dashboard: claim/done/review/block/next 接入 writeHeartbeat 副作用"
```

---

## Task 8: commands/heartbeat.cjs 兜底子命令

**Files:**
- Create: `~/.claude/skills/task-queue/commands/heartbeat.cjs`
- Create: `~/.claude/skills/task-queue/tests/commands.heartbeat.test.cjs`

**约束**：

- 接收可选 `--phase` 参数（默认 `idle`），调 writeHeartbeat
- 用途：loop-prompt 异常路径手工触发；日常流程不调

- [ ] **Step 1: 写测试**

`tests/commands.heartbeat.test.cjs`：

```javascript
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const heartbeatCmd = require('../commands/heartbeat.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cmd-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  return p;
}

test('heartbeat 子命令默认写 phase=idle', async () => {
  const proj = mkProj();
  const out = await captureStdout(() => heartbeatCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'idle');
});

test('heartbeat --phase sleeping 写指定 phase', async () => {
  const proj = mkProj();
  await captureStdout(() => heartbeatCmd(proj, ['--phase', 'sleeping']));
  const hb = readHeartbeat(proj);
  assert.equal(hb.phase, 'sleeping');
});

test('heartbeat 非法 phase 抛错', async () => {
  const proj = mkProj();
  await assert.rejects(() => heartbeatCmd(proj, ['--phase', 'bogus']), /phase/);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.heartbeat.test.cjs
```

Expected: 3 FAIL。

- [ ] **Step 3: 实现**

`commands/heartbeat.cjs`：

```javascript
'use strict';

const { writeHeartbeat } = require('../lib/heartbeat.cjs');

const VALID_PHASES = new Set(['executing', 'idle', 'sleeping']);

module.exports = async function heartbeat(projectRoot, args) {
  if (!projectRoot) throw new Error('heartbeat 需要 <project-root> 参数');
  let phase = 'idle';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phase') {
      phase = args[i + 1];
      i++;
    }
  }
  if (!VALID_PHASES.has(phase)) {
    throw new Error(`非法 phase: ${phase}（需为 ${[...VALID_PHASES].join('/')} 之一）`);
  }
  const ok = writeHeartbeat(projectRoot, { phase });
  process.stdout.write(JSON.stringify({ ok, phase }) + '\n');
};
```

- [ ] **Step 4: 跑测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.heartbeat.test.cjs
```

Expected: 3 pass。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/heartbeat.cjs tests/commands.heartbeat.test.cjs
git commit -m "task-queue dashboard: commands/heartbeat 兜底子命令"
```

---

## Task 9: lib/paused.cjs + loop-prompt Step 0.5

**Files:**
- Create: `~/.claude/skills/task-queue/lib/paused.cjs`
- Create: `~/.claude/skills/task-queue/tests/lib.paused.test.cjs`
- Modify: `~/.claude/skills/task-queue/loop-prompt.md:13-19`

**约束**：

- `setPaused(root, reason)` 写 `.tasks/run/loop-paused`（内容 = reason）
- `clearPaused(root)` 删除
- `readPaused(root)` 返回 reason 字符串或 null
- loop-prompt 加 Step 0.5：用 CLI 检查 paused 状态

- [ ] **Step 1: 写测试**

`tests/lib.paused.test.cjs`：

```javascript
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setPaused, clearPaused, readPaused } = require('../lib/paused.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paused-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  return p;
}

test('readPaused 文件不存在返回 null', () => {
  const proj = mkProj();
  assert.equal(readPaused(proj), null);
});

test('setPaused 后 readPaused 返回 reason', () => {
  const proj = mkProj();
  setPaused(proj, '手工暂停验证');
  assert.equal(readPaused(proj), '手工暂停验证');
});

test('clearPaused 删除文件后 readPaused 返回 null', () => {
  const proj = mkProj();
  setPaused(proj, 'foo');
  clearPaused(proj);
  assert.equal(readPaused(proj), null);
});

test('setPaused 覆盖原有 reason', () => {
  const proj = mkProj();
  setPaused(proj, 'a');
  setPaused(proj, 'b');
  assert.equal(readPaused(proj), 'b');
});

test('setPaused 空 reason 落地为空字符串（仍算暂停）', () => {
  const proj = mkProj();
  setPaused(proj, '');
  assert.equal(readPaused(proj), '');
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.paused.test.cjs
```

Expected: 5 FAIL。

- [ ] **Step 3: 实现 lib/paused.cjs**

`lib/paused.cjs`：

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pausedPath(projectRoot) {
  return path.join(projectRoot, '.tasks', 'run', 'loop-paused');
}

function setPaused(projectRoot, reason) {
  const p = pausedPath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(reason ?? ''));
}

function clearPaused(projectRoot) {
  try { fs.unlinkSync(pausedPath(projectRoot)); } catch (_) {}
}

function readPaused(projectRoot) {
  const p = pausedPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

module.exports = { setPaused, clearPaused, readPaused, pausedPath };
```

- [ ] **Step 4: 跑测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.paused.test.cjs
```

Expected: 5 pass。

- [ ] **Step 5: 改 loop-prompt.md 加 Step 0.5**

在 `loop-prompt.md` 当前 Step 0（recover）之后、Step 1（next）之前插入：

```markdown
## Step 0.5: 检查是否被面板暂停

```
node ~/.claude/skills/task-queue/tasks.cjs status ${PROJECT_ROOT}
```

如果输出含 `"paused": true`，跳到 Step 5（决定下次唤醒），不执行 next/claim。

设计意图：面板的 pause 只影响"取下一条"，不打断正在执行的任务。
```

（注：此 Step 依赖 status 命令报告 paused 状态，将在 Task 11 中实现。当前先在 prompt 留位。）

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/paused.cjs tests/lib.paused.test.cjs loop-prompt.md
git commit -m "task-queue dashboard: lib/paused（flag 文件）+ loop-prompt Step 0.5"
```

---

## Task 10: status 命令加 paused 字段

**Files:**
- Modify: `~/.claude/skills/task-queue/commands/status.cjs`
- Create/Modify: `~/.claude/skills/task-queue/tests/commands.status.test.cjs`

**约束**：

- status 命令输出加 `paused: bool, pauseReason: string|null` 两个字段
- loop-prompt Step 0.5 依赖这两个字段做决策

- [ ] **Step 1: 先 Read status.cjs 确认现有结构**

```bash
cat ~/.claude/skills/task-queue/commands/status.cjs
```

记录现有输出 schema 字段。

- [ ] **Step 2: 写测试**

追加或新建 `tests/commands.status.test.cjs`：

```javascript
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const statusCmd = require('../commands/status.cjs');
const { setPaused } = require('../lib/paused.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');
const { captureStdout } = require('./_helpers.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pause-test-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  await createBlankWorkbook(path.join(p, '.tasks', 'tasks.xlsx'));
  return p;
}

test('status 默认 paused=false', async () => {
  const proj = await mkProj();
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.paused, false);
  assert.equal(parsed.pauseReason, null);
});

test('status 在 paused flag 文件存在时报 paused=true 含 reason', async () => {
  const proj = await mkProj();
  setPaused(proj, '人工暂停');
  const out = await captureStdout(() => statusCmd(proj, []));
  const parsed = JSON.parse(out);
  assert.equal(parsed.paused, true);
  assert.equal(parsed.pauseReason, '人工暂停');
});
```

- [ ] **Step 3: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.status.test.cjs
```

Expected: 2 FAIL（assertions 失败，因为 status 还不输出 paused）。

- [ ] **Step 4: 改 status.cjs**

在 `commands/status.cjs` 顶部 require 区加：

```javascript
const { readPaused } = require('../lib/paused.cjs');
```

在最终输出 JSON 对象里加：

```javascript
  const pauseReason = readPaused(projectRoot);
  // ... 既有字段 ...
  paused: pauseReason !== null,
  pauseReason: pauseReason,
```

（实际位置需根据 status.cjs 当前结构调整，但核心是把上述两个字段塞进输出对象）

- [ ] **Step 5: 跑测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.status.test.cjs
```

Expected: 2 pass。

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/status.cjs tests/commands.status.test.cjs
git commit -m "task-queue dashboard: status 输出加 paused/pauseReason 字段"
```

---

## Task 11: dashboard-server 骨架（启动 + 静态文件）

**Files:**
- Create: `~/.claude/skills/task-queue/commands/dashboard-server.cjs`
- Create: `~/.claude/skills/task-queue/web/index.html`（最小占位）
- Create: `~/.claude/skills/task-queue/tests/dashboard-server.basic.test.cjs`

**约束**：

- export `startServer({ port, host })` 函数，返回 `{ server, port, close }`
- 监听 `127.0.0.1` 默认；`host: '0.0.0.0'` 显式打开
- 静态资源仅服务 `web/` 目录下的文件，做 path-traversal 防护
- 默认 path `/` → `web/index.html`
- 测试用 port 0 让系统分配

- [ ] **Step 1: 写最小占位 index.html**

`web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>task-queue dashboard</title>
</head>
<body>
  <h1>task-queue dashboard</h1>
  <p>v0.2.0 placeholder — 等 Task 15/16 实现真实 UI。</p>
</body>
</html>
```

- [ ] **Step 2: 写测试**

`tests/dashboard-server.basic.test.cjs`：

```javascript
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../commands/dashboard-server.cjs');

let inst;
after(async () => { if (inst) await inst.close(); });

test('startServer 监听 port 0 自动分配端口', async () => {
  inst = await startServer({ port: 0, host: '127.0.0.1' });
  assert.ok(inst.port > 0);
});

test('GET / 返回 index.html 内容', async () => {
  if (!inst) inst = await startServer({ port: 0, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${inst.port}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /task-queue dashboard/);
});

test('GET 不存在路径返回 404', async () => {
  const res = await fetch(`http://127.0.0.1:${inst.port}/nope`);
  assert.equal(res.status, 404);
});

test('GET 路径穿越尝试被拦截', async () => {
  const res = await fetch(`http://127.0.0.1:${inst.port}/../../../etc/passwd`);
  // 标准库会先规范化路径，404 即可；不应返回任何 root 外内容
  assert.notEqual(res.status, 200);
});
```

- [ ] **Step 3: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.basic.test.cjs
```

Expected: 4 FAIL。

- [ ] **Step 4: 实现 dashboard-server.cjs（骨架）**

`commands/dashboard-server.cjs`：

```javascript
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function serveStatic(req, res) {
  let urlPath = url.parse(req.url).pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(WEB_ROOT, urlPath));
  if (!filePath.startsWith(WEB_ROOT)) {
    return send(res, 403, 'forbidden');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return send(res, 404, 'not found');
  }
  const ext = path.extname(filePath);
  send(res, 200, fs.readFileSync(filePath), MIME[ext] || 'application/octet-stream');
}

function handle(req, res) {
  const parsed = url.parse(req.url, true);
  // API 路由在后续 task 加，这里先全走静态
  if (parsed.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'API not implemented yet' });
  }
  serveStatic(req, res);
}

async function startServer({ port = 5732, host = '127.0.0.1' } = {}) {
  const server = http.createServer(handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    async close() {
      await new Promise(r => server.close(r));
    },
  };
}

module.exports = { startServer };
```

- [ ] **Step 5: 跑测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.basic.test.cjs
```

Expected: 4 pass。

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/dashboard-server.cjs web/index.html tests/dashboard-server.basic.test.cjs
git commit -m "task-queue dashboard: server 骨架（静态文件 + 路径穿越防护）"
```

---

## Task 12: GET /api/projects 聚合接口

**Files:**
- Modify: `~/.claude/skills/task-queue/commands/dashboard-server.cjs`
- Create: `~/.claude/skills/task-queue/tests/dashboard-server.projects.test.cjs`

**约束**：

- GET `/api/projects` 返回 `{ projects: [...] }`，结构见 spec §4.1
- 每个项目并发读：`tasks.xlsx`、`heartbeat.json`、`loop-paused`
- root 不存在或 .tasks 不存在 → `online: "missing"`
- counts 取自 in_progress sheet 各状态分布 + done_today 取 archived sheet 今日完成
- phase 从 heartbeat 读，无心跳 → `online: "offline"`

- [ ] **Step 1: 写测试**

`tests/dashboard-server.projects.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
const { setPaused } = require('../lib/paused.cjs');
const { createBlankWorkbook, withWorkbook, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-proj-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProjWithRow(rows) {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  const xlsx = path.join(p, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  if (rows.length > 0) {
    await withWorkbook(xlsx, async wb => {
      rows.forEach(r => wb.getWorksheet(SHEET_IN_PROGRESS).addRow(r));
    });
  }
  return p;
}

test('GET /api/projects 空注册表返回空数组', async () => {
  inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  assert.deepEqual(body, { projects: [] });
});

test('GET /api/projects 含注册项目，counts 正确', async () => {
  const proj = await mkProjWithRow([
    { id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办' },
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '进行中' },
    { id: 3, desc: 'c', scope: 'web', priority: '中', status: '阻塞-等答疑' },
  ]);
  registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  assert.equal(body.projects.length, 1);
  const p = body.projects[0];
  assert.equal(p.root, proj);
  assert.equal(p.counts.todo, 1);
  assert.equal(p.counts.in_progress, 1);
  assert.equal(p.counts.blocked, 1);
});

test('GET /api/projects 心跳为 executing 时 currentTask 填充', async () => {
  const proj = await mkProjWithRow([
    { id: 5, desc: 'in progress task', scope: 'web', priority: '高', status: '进行中' },
  ]);
  registryAdd(proj);
  writeHeartbeat(proj, { phase: 'executing', currentTaskId: 5, currentTaskDesc: 'in progress task' });
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  const p = body.projects[0];
  assert.equal(p.phase, 'executing');
  assert.equal(p.currentTask.id, 5);
  assert.equal(p.currentTask.desc, 'in progress task');
});

test('GET /api/projects 项目目录失联 → online=missing', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'gone-'));
  registryAdd(proj);
  fs.rmSync(proj, { recursive: true });
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  const p = body.projects.find(x => x.root === proj);
  assert.equal(p.online, 'missing');
});

test('GET /api/projects paused 标志反映 paused=true', async () => {
  const proj = await mkProjWithRow([]);
  registryAdd(proj);
  setPaused(proj, '面板暂停了');
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects`);
  const body = await res.json();
  const p = body.projects.find(x => x.root === proj);
  assert.equal(p.paused, true);
  assert.equal(p.pauseReason, '面板暂停了');
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.projects.test.cjs
```

Expected: 5 FAIL。

- [ ] **Step 3: 实现 GET /api/projects**

在 `commands/dashboard-server.cjs` 顶部 require 区加：

```javascript
const { list: listProjects } = require('../lib/registry.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { readPaused } = require('../lib/paused.cjs');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
```

在文件底部、`module.exports` 之上加：

```javascript
function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function deriveOnline(hb) {
  if (!hb || !hb.ts) return 'offline';
  const ageMs = Date.now() - new Date(hb.ts).getTime();
  if (ageMs > 90 * 60 * 1000) return 'offline';
  if (hb.phase === 'executing' || ageMs < 5 * 60 * 1000) return 'active';
  return 'idle';
}

async function buildProjectSummary(entry) {
  const xlsx = path.join(entry.root, '.tasks', 'tasks.xlsx');
  if (!fs.existsSync(entry.root) || !fs.existsSync(xlsx)) {
    return { ...entry, online: 'missing', counts: null, phase: null,
             currentTask: null, lastFinished: null, paused: false, pauseReason: null,
             lastHeartbeat: null, lastModel: null };
  }
  const [rows, archived, hb, pauseReason] = await Promise.all([
    readRows(xlsx, SHEET_IN_PROGRESS),
    readRows(xlsx, SHEET_ARCHIVED),
    Promise.resolve(readHeartbeat(entry.root)),
    Promise.resolve(readPaused(entry.root)),
  ]);
  const counts = { todo: 0, in_progress: 0, review: 0, blocked: 0, done_today: 0 };
  for (const r of rows) {
    if (r.status === STATES.TODO) counts.todo++;
    else if (r.status === STATES.IN_PROGRESS) counts.in_progress++;
    else if (r.status === STATES.REVIEW) counts.review++;
    else if (r.status === STATES.BLOCKED) counts.blocked++;
  }
  const todayStart = startOfTodayIso();
  for (const r of archived) {
    if (r.status === STATES.DONE && r.ftime && String(r.ftime) >= todayStart) counts.done_today++;
  }
  const inProgressRow = rows.find(r => r.status === STATES.IN_PROGRESS);
  const currentTask = hb && hb.phase === 'executing' && hb.currentTaskId != null
    ? { id: hb.currentTaskId, desc: hb.currentTaskDesc,
        scope: inProgressRow ? inProgressRow.scope : null,
        priority: inProgressRow ? inProgressRow.priority : null }
    : null;
  return {
    ...entry,
    online: deriveOnline(hb),
    phase: hb ? hb.phase : null,
    lastHeartbeat: hb ? hb.ts : null,
    lastModel: hb ? hb.model : null,
    paused: pauseReason !== null,
    pauseReason: pauseReason,
    counts,
    currentTask,
    lastFinished: hb && hb.lastFinishedId != null
      ? { id: hb.lastFinishedId, at: hb.lastFinishedAt }
      : null,
  };
}

async function handleApiProjects(req, res) {
  const projects = await Promise.all(listProjects().map(buildProjectSummary));
  sendJson(res, 200, { projects });
}
```

修改 `handle` 函数，在 `if (parsed.pathname.startsWith('/api/'))` 块内分发：

```javascript
function handle(req, res) {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/api/projects' && req.method === 'GET') {
    return handleApiProjects(req, res).catch(e => sendJson(res, 500, { error: e.message }));
  }
  if (parsed.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'unknown api route' });
  }
  serveStatic(req, res);
}
```

- [ ] **Step 4: 跑测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.projects.test.cjs
```

Expected: 5 pass。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/dashboard-server.cjs tests/dashboard-server.projects.test.cjs
git commit -m "task-queue dashboard: GET /api/projects 聚合接口"
```

---

## Task 13: GET /api/projects/:slug 详情接口

**Files:**
- Modify: `~/.claude/skills/task-queue/commands/dashboard-server.cjs`
- Create: `~/.claude/skills/task-queue/tests/dashboard-server.detail.test.cjs`

**约束**：

- 返回 `{ project: {...}, tasks: { in_progress, todo, review, blocked, done_today } }`
- slug 不存在 → 404
- in_progress sheet 按状态分组；done_today 从 archived sheet 取
- 列表内字段：id, desc, scope, priority, ctime, note, risk?, question?

- [ ] **Step 1: 写测试**

`tests/dashboard-server.detail.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { createBlankWorkbook, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-detail-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProj(inRows, archRows = []) {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  const xlsx = path.join(p, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  await withWorkbook(xlsx, async wb => {
    inRows.forEach(r => wb.getWorksheet(SHEET_IN_PROGRESS).addRow(r));
    archRows.forEach(r => wb.getWorksheet(SHEET_ARCHIVED).addRow(r));
  });
  return p;
}

test('GET /api/projects/:slug 不存在 → 404', async () => {
  inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/no-such-slug`);
  assert.equal(res.status, 404);
});

test('GET /api/projects/:slug 返回分组任务列表', async () => {
  const todayIso = new Date().toISOString();
  const proj = await mkProj(
    [
      { id: 1, desc: 't1', scope: 'web', priority: '中', status: '待办', ctime: todayIso },
      { id: 2, desc: 't2', scope: 'web', priority: '高', status: '进行中', ctime: todayIso },
      { id: 3, desc: 't3', scope: 'web', priority: '低', status: '已完成-待review', risk: 'r1', ctime: todayIso },
      { id: 4, desc: 't4', scope: 'web', priority: '中', status: '阻塞-等答疑', question: 'q1', ctime: todayIso },
    ],
    [
      { id: 99, desc: 't99', scope: 'web', priority: '中', status: '已完成', ftime: todayIso },
    ],
  );
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });

  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  const body = await res.json();
  assert.equal(body.project.slug, entry.slug);
  assert.equal(body.tasks.todo.length, 1);
  assert.equal(body.tasks.in_progress.length, 1);
  assert.equal(body.tasks.review.length, 1);
  assert.equal(body.tasks.blocked.length, 1);
  assert.equal(body.tasks.done_today.length, 1);
  assert.equal(body.tasks.review[0].risk, 'r1');
  assert.equal(body.tasks.blocked[0].question, 'q1');
});

test('GET /api/projects/:slug 非法 slug 格式 → 400', async () => {
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/Bad!Slug`);
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.detail.test.cjs
```

Expected: 3 FAIL。

- [ ] **Step 3: 实现详情接口**

在 `commands/dashboard-server.cjs` 加：

```javascript
const SLUG_RE = /^[a-z0-9-]+$/;

async function buildProjectDetail(entry) {
  const summary = await buildProjectSummary(entry);
  if (summary.online === 'missing') {
    return { project: summary, tasks: { in_progress: [], todo: [], review: [], blocked: [], done_today: [] } };
  }
  const xlsx = path.join(entry.root, '.tasks', 'tasks.xlsx');
  const [rows, archived] = await Promise.all([
    readRows(xlsx, SHEET_IN_PROGRESS),
    readRows(xlsx, SHEET_ARCHIVED),
  ]);
  const pickFields = (r) => ({
    id: r.id, desc: r.desc, scope: r.scope, priority: r.priority,
    ctime: r.ctime, note: r.note, risk: r.risk, question: r.question,
  });
  const tasks = { in_progress: [], todo: [], review: [], blocked: [], done_today: [] };
  for (const r of rows) {
    if (r.status === STATES.TODO) tasks.todo.push(pickFields(r));
    else if (r.status === STATES.IN_PROGRESS) tasks.in_progress.push(pickFields(r));
    else if (r.status === STATES.REVIEW) tasks.review.push(pickFields(r));
    else if (r.status === STATES.BLOCKED) tasks.blocked.push(pickFields(r));
  }
  const todayStart = startOfTodayIso();
  for (const r of archived) {
    if (r.status === STATES.DONE && r.ftime && String(r.ftime) >= todayStart) {
      tasks.done_today.push({ ...pickFields(r), ftime: r.ftime });
    }
  }
  return { project: summary, tasks };
}

async function handleApiProjectDetail(req, res, slug) {
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug' });
  const entry = listProjects().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });
  const detail = await buildProjectDetail(entry);
  sendJson(res, 200, detail);
}
```

修改 `handle` 加路由分发：

```javascript
function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const m = parsed.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (parsed.pathname === '/api/projects' && req.method === 'GET') {
    return handleApiProjects(req, res).catch(e => sendJson(res, 500, { error: e.message }));
  }
  if (m && req.method === 'GET') {
    return handleApiProjectDetail(req, res, m[1]).catch(e => sendJson(res, 500, { error: e.message }));
  }
  if (parsed.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'unknown api route' });
  }
  serveStatic(req, res);
}
```

- [ ] **Step 4: 跑测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.detail.test.cjs
```

Expected: 3 pass。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/dashboard-server.cjs tests/dashboard-server.detail.test.cjs
git commit -m "task-queue dashboard: GET /api/projects/:slug 详情接口（分组任务列表）"
```

---

## Task 14: POST skip / priority 写接口

**Files:**
- Modify: `~/.claude/skills/task-queue/commands/dashboard-server.cjs`
- Create: `~/.claude/skills/task-queue/tests/dashboard-server.write-tasks.test.cjs`

**约束**：

- `POST /api/projects/:slug/skip` body `{ id }` → 状态 待办 → 跳过
- `POST /api/projects/:slug/priority` body `{ id, priority }` → 改优先级（仅 待办）
- 走 `withWorkbook`（自动加锁，与 loop 共享）
- 非 待办 状态返回 409 Conflict
- id / priority 校验失败返回 400

- [ ] **Step 1: 写测试**

`tests/dashboard-server.write-tasks.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { createBlankWorkbook, withWorkbook, readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-write-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProj(rows) {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  const xlsx = path.join(p, '.tasks', 'tasks.xlsx');
  await createBlankWorkbook(xlsx);
  await withWorkbook(xlsx, async wb => {
    rows.forEach(r => wb.getWorksheet(SHEET_IN_PROGRESS).addRow(r));
  });
  return p;
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST skip 把 待办 改为 跳过', async () => {
  const proj = await mkProj([
    { id: 1, desc: 'a', scope: 'web', priority: '中', status: '待办' },
  ]);
  const entry = registryAdd(proj);
  inst = await startServer({ port: 0 });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/skip`, { id: 1 });
  assert.equal(res.status, 200);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '跳过');
});

test('POST skip 非 待办 → 409', async () => {
  const proj = await mkProj([
    { id: 2, desc: 'b', scope: 'web', priority: '中', status: '进行中' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/skip`, { id: 2 });
  assert.equal(res.status, 409);
});

test('POST skip id 不存在 → 404', async () => {
  const proj = await mkProj([]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/skip`, { id: 99 });
  assert.equal(res.status, 404);
});

test('POST priority 改 待办 任务优先级', async () => {
  const proj = await mkProj([
    { id: 3, desc: 'c', scope: 'web', priority: '中', status: '待办' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/priority`,
    { id: 3, priority: '高' },
  );
  assert.equal(res.status, 200);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].priority, '高');
});

test('POST priority 非法值 → 400', async () => {
  const proj = await mkProj([
    { id: 4, desc: 'd', scope: 'web', priority: '中', status: '待办' },
  ]);
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/priority`,
    { id: 4, priority: '紧急' },
  );
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.write-tasks.test.cjs
```

Expected: 5 FAIL。

- [ ] **Step 3: 实现写接口**

在 `commands/dashboard-server.cjs` 加：

```javascript
const { withWorkbook, colIndex } = require('../lib/workbook.cjs');
const { PRIORITY_ORDER } = require('../lib/states.cjs');

const VALID_PRIORITIES = new Set(PRIORITY_ORDER);

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function mutateTaskRow(entry, taskId, expectedStatus, mutate) {
  const xlsx = path.join(entry.root, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsx, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(taskId));
  if (!target) return { ok: false, code: 404, error: 'task not found' };
  if (target.status !== expectedStatus) {
    return { ok: false, code: 409, error: `expected status ${expectedStatus}, got ${target.status}` };
  }
  await withWorkbook(xlsx, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(target._rowNumber);
    mutate(row);
    row.commit();
  });
  return { ok: true };
}

async function handleSkip(req, res, slug) {
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug' });
  const entry = listProjects().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body || body.id == null) return sendJson(res, 400, { error: 'missing id' });
  const result = await mutateTaskRow(entry, body.id, STATES.TODO, row => {
    row.getCell(colIndex('status')).value = STATES.SKIPPED;
  });
  if (!result.ok) return sendJson(res, result.code, { error: result.error });
  sendJson(res, 200, { ok: true });
}

async function handlePriority(req, res, slug) {
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug' });
  const entry = listProjects().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body || body.id == null) return sendJson(res, 400, { error: 'missing id' });
  if (!VALID_PRIORITIES.has(body.priority)) {
    return sendJson(res, 400, { error: `invalid priority: ${body.priority}` });
  }
  const result = await mutateTaskRow(entry, body.id, STATES.TODO, row => {
    row.getCell(colIndex('priority')).value = body.priority;
  });
  if (!result.ok) return sendJson(res, result.code, { error: result.error });
  sendJson(res, 200, { ok: true });
}
```

修改 `handle` 函数，在 detail 路由之前加：

```javascript
  const skipM = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/skip$/);
  if (skipM && req.method === 'POST') {
    return handleSkip(req, res, skipM[1]).catch(e => sendJson(res, 500, { error: e.message }));
  }
  const prioM = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/priority$/);
  if (prioM && req.method === 'POST') {
    return handlePriority(req, res, prioM[1]).catch(e => sendJson(res, 500, { error: e.message }));
  }
```

- [ ] **Step 4: 跑测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.write-tasks.test.cjs
```

Expected: 5 pass。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/dashboard-server.cjs tests/dashboard-server.write-tasks.test.cjs
git commit -m "task-queue dashboard: POST skip / priority 写接口（待办状态校验 + 409）"
```

---

## Task 15: POST pause / resume / DELETE project

**Files:**
- Modify: `~/.claude/skills/task-queue/commands/dashboard-server.cjs`
- Create: `~/.claude/skills/task-queue/tests/dashboard-server.pause.test.cjs`

**约束**：

- `POST /api/projects/:slug/pause` body `{ reason }` → 写 loop-paused
- `POST /api/projects/:slug/resume` → 删 loop-paused
- `DELETE /api/projects/:slug` → unregister（移出注册表，不删 .tasks/）

- [ ] **Step 1: 写测试**

`tests/dashboard-server.pause.test.cjs`：

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd, list: listReg } = require('../lib/registry.cjs');
const { readPaused } = require('../lib/paused.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-pause-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProj() {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  await createBlankWorkbook(path.join(p, '.tasks', 'tasks.xlsx'));
  return p;
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

test('POST pause 写 loop-paused 含 reason', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  inst = await startServer({ port: 0 });
  const res = await postJson(
    `http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/pause`,
    { reason: '面板手动暂停' },
  );
  assert.equal(res.status, 200);
  assert.equal(readPaused(proj), '面板手动暂停');
});

test('POST resume 删 loop-paused', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  await postJson(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/pause`, { reason: 'x' });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}/resume`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(readPaused(proj), null);
});

test('DELETE /api/projects/:slug 移出注册表', async () => {
  const proj = await mkProj();
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(listReg().find(p => p.slug === entry.slug), undefined);
  assert.equal(fs.existsSync(proj), true, '.tasks 目录不应被删');
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.pause.test.cjs
```

Expected: 3 FAIL。

- [ ] **Step 3: 实现**

在 `commands/dashboard-server.cjs` 顶部 require 区加：

```javascript
const { setPaused, clearPaused } = require('../lib/paused.cjs');
const { remove: registryRemove } = require('../lib/registry.cjs');
```

实现 handler：

```javascript
async function handlePause(req, res, slug) {
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug' });
  const entry = listProjects().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });
  const body = await readJsonBody(req).catch(() => ({}));
  setPaused(entry.root, body.reason || '面板暂停');
  sendJson(res, 200, { ok: true });
}

async function handleResume(_req, res, slug) {
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug' });
  const entry = listProjects().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });
  clearPaused(entry.root);
  sendJson(res, 200, { ok: true });
}

async function handleDelete(_req, res, slug) {
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug' });
  registryRemove(slug);
  sendJson(res, 200, { ok: true });
}
```

`handle` 函数加路由：

```javascript
  const pauseM = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/pause$/);
  if (pauseM && req.method === 'POST') {
    return handlePause(req, res, pauseM[1]).catch(e => sendJson(res, 500, { error: e.message }));
  }
  const resumeM = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/resume$/);
  if (resumeM && req.method === 'POST') {
    return handleResume(req, res, resumeM[1]).catch(e => sendJson(res, 500, { error: e.message }));
  }
  if (m && req.method === 'DELETE') {
    return handleDelete(req, res, m[1]).catch(e => sendJson(res, 500, { error: e.message }));
  }
```

- [ ] **Step 4: 跑测试通过**

```bash
cd ~/.claude/skills/task-queue && node --test tests/dashboard-server.pause.test.cjs
```

Expected: 3 pass。

- [ ] **Step 5: 跑全套回归**

```bash
cd ~/.claude/skills/task-queue && node --test tests/*.test.cjs
```

Expected: 全 pass，无 regression。

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/dashboard-server.cjs tests/dashboard-server.pause.test.cjs
git commit -m "task-queue dashboard: POST pause/resume + DELETE 移出注册表"
```

---

## Task 16: web/styles.css + 完整 index.html

**Files:**
- Modify: `~/.claude/skills/task-queue/web/index.html`
- Create: `~/.claude/skills/task-queue/web/styles.css`

**约束**：

- 两栏布局：左 240px 项目列表 + 右弹性详情
- 深色主题
- 状态颜色：绿（active）/ 黄（idle）/ 红（blocked）/ 灰（offline）
- 不引外部 CSS / 字体

- [ ] **Step 1: 写 styles.css**

`web/styles.css`：

```css
:root {
  --bg: #1a1d23;
  --panel: #242832;
  --border: #2f343d;
  --text: #e4e6eb;
  --text-dim: #8b929e;
  --accent: #4ea1f7;
  --green: #56c47b;
  --yellow: #f5b948;
  --red: #e85d5d;
  --gray: #6c7280;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans", sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}

#app {
  display: flex;
  height: 100vh;
}

#sidebar {
  width: 260px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 12px 8px;
}

#sidebar h1 {
  font-size: 14px;
  margin: 8px 8px 16px;
  color: var(--text-dim);
}

.project-item {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 4px;
}
.project-item:hover { background: var(--panel); }
.project-item.active { background: var(--panel); }
.project-item .name { font-weight: 500; }
.project-item .summary { color: var(--text-dim); font-size: 12px; margin-top: 4px; }

.dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
.dot.active { background: var(--green); }
.dot.idle { background: var(--yellow); }
.dot.offline { background: var(--gray); }
.dot.missing { background: var(--red); }

#detail {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}
#detail h2 { font-size: 18px; margin: 0 0 4px; }
#detail .meta { color: var(--text-dim); font-size: 12px; margin-bottom: 20px; }

.current-task {
  background: var(--panel);
  border-left: 3px solid var(--green);
  padding: 12px 16px;
  border-radius: 4px;
  margin-bottom: 24px;
}
.current-task .label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
.current-task .title { font-size: 14px; margin: 4px 0; }
.current-task .tags { display: flex; gap: 8px; }
.tag { font-size: 11px; padding: 2px 6px; border-radius: 3px; background: var(--bg); }

.group { margin-bottom: 20px; }
.group-header {
  display: flex; justify-content: space-between; align-items: center;
  cursor: pointer; padding: 8px 0; user-select: none;
  border-bottom: 1px solid var(--border);
}
.group-header:hover { color: var(--accent); }
.group-title { font-weight: 500; }
.group-count { color: var(--text-dim); font-size: 12px; }
.group-body { display: none; padding-top: 8px; }
.group.expanded .group-body { display: block; }

.task-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 0; border-bottom: 1px solid var(--border);
}
.task-row:last-child { border-bottom: none; }
.task-desc { flex: 1; }
.task-actions { display: flex; gap: 6px; }
.btn {
  background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer;
}
.btn:hover { background: var(--bg); }
.btn.danger { color: var(--red); }
.btn.primary { background: var(--accent); border-color: var(--accent); }

.pause-bar {
  position: fixed; bottom: 16px; right: 24px;
}
.pause-bar.paused { background: var(--yellow); color: #000; padding: 8px 16px; border-radius: 6px; }
```

- [ ] **Step 2: 改完整 index.html**

替换 `web/index.html` 内容：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>task-queue dashboard</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <h1>task-queue</h1>
      <div id="project-list">加载中...</div>
    </aside>
    <main id="detail">
      <div id="detail-empty">从左侧选一个项目查看详情</div>
      <div id="detail-content" style="display:none"></div>
    </main>
  </div>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/task-queue
git add web/index.html web/styles.css
git commit -m "task-queue dashboard: web/ 静态资源（深色主题两栏布局）"
```

---

## Task 17: web/app.js — 渲染 + 轮询 + 写操作

**Files:**
- Create: `~/.claude/skills/task-queue/web/app.js`

**约束**：

- 5s 轮询 `/api/projects`，渲染左侧
- 选中项目时 GET `/api/projects/:slug`，渲染详情
- 各 group 默认折叠（除 in_progress），点 header 切换
- skip / priority / pause / resume 按钮调 POST，成功后立即重新拉取
- 无前端框架，纯 DOM

- [ ] **Step 1: 写 app.js**

`web/app.js`：

```javascript
'use strict';

const state = {
  projects: [],
  selectedSlug: null,
  detail: null,
  expanded: { in_progress: true, todo: false, review: false, blocked: false, done_today: false },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

async function fetchProjects() {
  const r = await fetch('/api/projects');
  return r.json();
}

async function fetchDetail(slug) {
  const r = await fetch(`/api/projects/${slug}`);
  if (!r.ok) return null;
  return r.json();
}

async function postAction(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? 'POST' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}

function statusLabel(p) {
  if (p.online === 'missing') return '失联';
  if (p.online === 'offline') return '离线';
  if (p.phase === 'executing') return `运行中 #${p.currentTask?.id ?? ''}`;
  if (p.phase === 'sleeping') return '队列空';
  if (p.online === 'active') return '活跃';
  return '等待中';
}

function renderProjects() {
  const list = $('#project-list');
  list.innerHTML = '';
  if (state.projects.length === 0) {
    list.appendChild(el('div', { className: 'project-item' }, '（无已注册项目）'));
    return;
  }
  for (const p of state.projects) {
    const item = el('div', {
      className: 'project-item' + (p.slug === state.selectedSlug ? ' active' : ''),
      onclick: () => selectProject(p.slug),
    },
      el('div', { className: 'name' },
        el('span', { className: `dot ${p.online}` }), p.name,
      ),
      el('div', { className: 'summary' }, statusLabel(p)),
    );
    list.appendChild(item);
  }
}

function renderTaskRow(t, group) {
  const actions = [];
  if (group === 'todo') {
    actions.push(el('button', {
      className: 'btn',
      onclick: () => changePriority(t.id),
    }, '改优先级'));
    actions.push(el('button', {
      className: 'btn danger',
      onclick: () => skipTask(t.id),
    }, 'skip'));
  }
  return el('div', { className: 'task-row' },
    el('div', { className: 'task-desc' },
      el('div', null, `#${t.id} ${t.desc}`),
      el('div', { className: 'meta', style: 'font-size:11px;color:var(--text-dim)' },
        `scope: ${t.scope}  ·  优先级: ${t.priority}` + (t.risk ? `  ·  风险: ${t.risk}` : '')
        + (t.question ? `  ·  疑问: ${t.question}` : ''),
      ),
    ),
    el('div', { className: 'task-actions' }, ...actions),
  );
}

function renderGroup(label, key, items) {
  const expanded = state.expanded[key] || items.length > 0 && key === 'in_progress';
  return el('div', { className: 'group' + (expanded ? ' expanded' : '') },
    el('div', {
      className: 'group-header',
      onclick: (e) => { state.expanded[key] = !state.expanded[key]; renderDetail(); },
    },
      el('span', { className: 'group-title' }, label),
      el('span', { className: 'group-count' }, `(${items.length})`),
    ),
    el('div', { className: 'group-body' },
      ...items.map(t => renderTaskRow(t, key)),
    ),
  );
}

function renderDetail() {
  $('#detail-empty').style.display = state.detail ? 'none' : 'block';
  const c = $('#detail-content');
  c.style.display = state.detail ? 'block' : 'none';
  if (!state.detail) return;

  const { project: p, tasks } = state.detail;
  c.innerHTML = '';
  c.appendChild(el('h2', null, p.name, ' ', el('span', { className: `dot ${p.online}` })));
  c.appendChild(el('div', { className: 'meta' },
    `${statusLabel(p)} · 上次心跳: ${p.lastHeartbeat ? new Date(p.lastHeartbeat).toLocaleString() : '—'} · 模型: ${p.lastModel ?? '—'}`,
  ));

  if (p.currentTask) {
    c.appendChild(el('div', { className: 'current-task' },
      el('div', { className: 'label' }, '正在执行'),
      el('div', { className: 'title' }, `#${p.currentTask.id} ${p.currentTask.desc}`),
      el('div', { className: 'tags' },
        el('span', { className: 'tag' }, `scope: ${p.currentTask.scope ?? '—'}`),
        el('span', { className: 'tag' }, `优先级: ${p.currentTask.priority ?? '—'}`),
      ),
    ));
  }

  c.appendChild(renderGroup('进行中', 'in_progress', tasks.in_progress));
  c.appendChild(renderGroup('待办', 'todo', tasks.todo));
  c.appendChild(renderGroup('待 review', 'review', tasks.review));
  c.appendChild(renderGroup('阻塞', 'blocked', tasks.blocked));
  c.appendChild(renderGroup('今日完成', 'done_today', tasks.done_today));

  const pauseBtn = el('button', {
    className: 'btn primary',
    onclick: () => p.paused ? resumeProject() : pauseProject(),
  }, p.paused ? `resume (原因: ${p.pauseReason})` : 'pause loop');
  c.appendChild(el('div', { className: 'pause-bar' + (p.paused ? ' paused' : '') }, pauseBtn));
}

async function refreshProjects() {
  try {
    const data = await fetchProjects();
    state.projects = data.projects;
    renderProjects();
    if (state.selectedSlug) await refreshDetail();
  } catch (e) {
    console.error('refresh failed', e);
  }
}

async function refreshDetail() {
  if (!state.selectedSlug) return;
  state.detail = await fetchDetail(state.selectedSlug);
  renderDetail();
}

async function selectProject(slug) {
  state.selectedSlug = slug;
  await refreshDetail();
  renderProjects();
}

async function skipTask(id) {
  if (!confirm(`确认跳过任务 #${id}？`)) return;
  await postAction(`/api/projects/${state.selectedSlug}/skip`, { id });
  await refreshProjects();
}

async function changePriority(id) {
  const p = prompt('改为优先级（高/中/低）');
  if (!['高', '中', '低'].includes(p)) return;
  await postAction(`/api/projects/${state.selectedSlug}/priority`, { id, priority: p });
  await refreshProjects();
}

async function pauseProject() {
  const reason = prompt('暂停原因？', '面板手动暂停');
  if (reason == null) return;
  await postAction(`/api/projects/${state.selectedSlug}/pause`, { reason });
  await refreshProjects();
}

async function resumeProject() {
  await postAction(`/api/projects/${state.selectedSlug}/resume`);
  await refreshProjects();
}

refreshProjects();
setInterval(refreshProjects, 5000);
```

- [ ] **Step 2: 手工验证（端到端预演）**

```bash
# 在临时项目跑一遍
cd /tmp && rm -rf dash-test && mkdir dash-test && cd dash-test
git init -b lisq -q
echo '{"name":"x","version":"1.0.0"}' > package.json
node ~/.claude/skills/task-queue/tasks.cjs init-write . '{"autoCommitScopes":["web"],"scopeMapping":{"web":{"dir":".","versionFile":"package.json","changelogFile":"CHANGELOG.md","buildCommand":"true"}},"candidateModules":{"web":["全局"]},"commitTemplate":{"web":"T#0000 web## __VERSION__"},"sameDayShareVersion":true}'
node ~/.claude/skills/task-queue/tasks.cjs add-row . "测试任务一" web 中
node ~/.claude/skills/task-queue/tasks.cjs add-row . "测试任务二" web 高
# 启动 server 后台
TASK_QUEUE_PORT=5732 node -e "require('/Users/seth/.claude/skills/task-queue/commands/dashboard-server.cjs').startServer({port:5732}).then(i => console.log('listening on', i.port))" &
SERVER_PID=$!
sleep 1
curl -s http://127.0.0.1:5732/api/projects | head -200
curl -s http://127.0.0.1:5732/api/projects/dash-test | head -200
kill $SERVER_PID 2>/dev/null
```

预期：JSON 返回含 dash-test 项目和两条待办任务。

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/task-queue
git add web/app.js
git commit -m "task-queue dashboard: web/app.js（5s 轮询 + skip/priority/pause/resume）"
```

---

## Task 18: commands/dashboard.cjs dispatcher + tasks.cjs 注册

**Files:**
- Create: `~/.claude/skills/task-queue/commands/dashboard.cjs`
- Modify: `~/.claude/skills/task-queue/tasks.cjs`

**约束**：

- `dashboard.cjs` 是 user-facing 入口，根据 args[0] 派发到 server / register / unregister / list
- 默认（无 args）= serve（启动 http）
- `tasks.cjs` 把 `dashboard` 和 `heartbeat` 加入 KNOWN_COMMANDS
- `dashboard` 加入 COMMANDS_NOT_REQUIRING_PROJECT_ROOT（启动 server 不需要 root）

- [ ] **Step 1: 写 dashboard.cjs**

`commands/dashboard.cjs`：

```javascript
'use strict';

const { startServer } = require('./dashboard-server.cjs');
const registerCmd = require('./dashboard-register.cjs');
const unregisterCmd = require('./dashboard-unregister.cjs');
const listCmd = require('./dashboard-list.cjs');

function parsePort(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') return parseInt(args[i + 1], 10);
  }
  return parseInt(process.env.TASK_QUEUE_PORT, 10) || 5732;
}

function parseHost(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host') return args[i + 1];
  }
  return process.env.TASK_QUEUE_HOST || '127.0.0.1';
}

async function serve(args) {
  const port = parsePort(args);
  const host = parseHost(args);
  const inst = await startServer({ port, host });
  process.stdout.write(`dashboard ready at http://${host}:${inst.port}\n`);
  // 优雅退出
  const shutdown = async () => {
    process.stdout.write('shutting down dashboard...\n');
    await inst.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = async function dashboard(projectRoot, args) {
  const sub = args[0];
  if (sub === 'register') return registerCmd(projectRoot, args.slice(1));
  if (sub === 'unregister') return unregisterCmd(projectRoot, args.slice(1));
  if (sub === 'list') return listCmd(projectRoot, args.slice(1));
  // 默认 / serve
  if (!sub || sub === 'serve' || sub.startsWith('--')) {
    return serve(sub && sub.startsWith('--') ? args : args.slice(1));
  }
  throw new Error(`dashboard 未知子命令: ${sub}（可选: serve/register/unregister/list）`);
};
```

- [ ] **Step 2: 改 tasks.cjs**

修改 `tasks.cjs`，KNOWN_COMMANDS 和 COMMANDS_NOT_REQUIRING_PROJECT_ROOT：

```javascript
const KNOWN_COMMANDS = [
  'detect', 'init-write', 'next', 'claim', 'done', 'review',
  'block', 'status', 'sweep', 'recover', 'add-row', 'test-push',
  'dashboard', 'heartbeat',
];

const COMMANDS_NOT_REQUIRING_PROJECT_ROOT = new Set(['detect', 'init-write', 'test-push', 'dashboard']);
```

注意：`dashboard register <root>` 时 root 作为第二位参数传入；按 dispatcher 设计，dashboard 主函数从 args[1] 拿 root。但 register 需要 projectRoot 参数 —— 这里特殊处理：当 sub 是 register 时，把 args[1] 作为 root 传给 register 子命令。

更新 `commands/dashboard.cjs` 中 register 派发：

```javascript
  if (sub === 'register') {
    // dashboard register <root>
    return registerCmd(args[1], args.slice(2));
  }
```

`tasks.cjs` 调用 `dashboard.cjs` 时传 `projectRoot` 是 undefined（因为 dashboard 不需要 root），所以 dashboard 自己从 args 里取。

- [ ] **Step 3: 手工冒烟测试**

```bash
node ~/.claude/skills/task-queue/tasks.cjs dashboard list
node ~/.claude/skills/task-queue/tasks.cjs dashboard register /tmp/dash-test
node ~/.claude/skills/task-queue/tasks.cjs dashboard list
node ~/.claude/skills/task-queue/tasks.cjs dashboard unregister dash-test
# 启动 server 测试（5s 后 Ctrl+C）
timeout 5 node ~/.claude/skills/task-queue/tasks.cjs dashboard --port 5733
```

预期：list 显示 dash-test；unregister 后消失；启动 server 输出 `dashboard ready at http://127.0.0.1:5733`。

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/dashboard.cjs tasks.cjs
git commit -m "task-queue dashboard: commands/dashboard dispatcher + tasks.cjs 注册"
```

---

## Task 19: SKILL.md 文档 + v0.2.0 tag

**Files:**
- Modify: `~/.claude/skills/task-queue/SKILL.md`

**约束**：

- "用户喊词识别" 表加 3 行：启动面板 / 暂停队列 / 恢复队列
- "子命令一览" 表加 `dashboard [serve|register|unregister|list]` 和 `heartbeat` 两行
- 新增 §dashboard 段落简介

- [ ] **Step 1: 改 SKILL.md 喊词表**

在 SKILL.md 喊词识别表中追加：

```markdown
| `/task-queue dashboard` / "启动面板" / "打开控制台" | 跑 `dashboard` 启动 Web 服务，告知 URL |
| "暂停队列" / "pause loop" | 跑 `dashboard pause <slug>` 或提示在面板操作 |
| "恢复队列" / "resume loop" | 跑 `dashboard resume <slug>` 或提示在面板操作 |
```

- [ ] **Step 2: 改 SKILL.md 子命令一览**

在子命令一览表中加：

```markdown
| `dashboard [serve\|register\|unregister\|list] [--port 5732] [--host 127.0.0.1]` | 启动本地 Web 面板 / 管理注册表 |
| `heartbeat <root> [--phase <executing\|idle\|sleeping>]` | 兜底手工写心跳（claim/done 等已自动写，正常流程不需要调） |
```

- [ ] **Step 3: 在 SKILL.md 末尾加 §dashboard 段**

追加：

```markdown
## §dashboard 流程

### 启动面板

```bash
node ~/.claude/skills/task-queue/tasks.cjs dashboard
```

默认 `127.0.0.1:5732`。打开浏览器访问该 URL 即可看到所有已注册项目的实时状态。

面板能力：
- 看每个项目的 `phase`（运行中/等待中/离线）+ 当前任务 desc
- 点 "skip" 跳过一条待办
- 点 "改优先级" 调整待办的高/中/低
- 点 "pause" 暂停 loop（正在执行的任务跑完后停下；下一轮 next 不取）
- 点 "resume" 恢复

### 多项目聚合

`init-write` 自动把项目加入 `~/.task-queue/projects.json` 注册表。早期 init 时漏注册的项目可手动补：

```bash
node ~/.claude/skills/task-queue/tasks.cjs dashboard register /path/to/project
```

### 安全

默认仅监听 loopback。若需局域网访问：`--host 0.0.0.0`，但无认证，请勿暴露公网。
```

- [ ] **Step 4: 端到端 dry-run（手工验收清单）**

按 spec §11 验收标准跑：

```bash
# 1. 启动 dashboard
mkdir -p /tmp/tq-e2e && cd /tmp/tq-e2e && git init -b lisq -q
echo '{"name":"x","version":"1.0.0"}' > package.json
node ~/.claude/skills/task-queue/tasks.cjs init-write . '{"autoCommitScopes":["web"],"scopeMapping":{"web":{"dir":".","versionFile":"package.json","changelogFile":"CHANGELOG.md","buildCommand":"true"}},"candidateModules":{"web":["全局"]},"commitTemplate":{"web":"T#0000 web## __VERSION__"},"sameDayShareVersion":true}'
node ~/.claude/skills/task-queue/tasks.cjs add-row . "测试任务一" web 中
node ~/.claude/skills/task-queue/tasks.cjs add-row . "测试任务二" web 高
node ~/.claude/skills/task-queue/tasks.cjs dashboard --port 5732 &
SERVER_PID=$!
sleep 1

# 2. 浏览器访问 http://127.0.0.1:5732 应看到 tq-e2e 项目 + 2 个待办
# 3. claim → done 验心跳
node ~/.claude/skills/task-queue/tasks.cjs claim . auto
sleep 1
curl -s http://127.0.0.1:5732/api/projects | grep -o '"phase":"executing"'

# 4. skip + priority + pause/resume via curl
curl -X POST -H 'Content-Type: application/json' -d '{"id":2}' http://127.0.0.1:5732/api/projects/tq-e2e/skip
curl -X POST -H 'Content-Type: application/json' -d '{"reason":"测试暂停"}' http://127.0.0.1:5732/api/projects/tq-e2e/pause
curl -X POST http://127.0.0.1:5732/api/projects/tq-e2e/resume

# 5. 清理
kill $SERVER_PID
node ~/.claude/skills/task-queue/tasks.cjs dashboard unregister tq-e2e
cd / && rm -rf /tmp/tq-e2e
```

预期所有 curl 返回 200，`phase=executing` 出现，skip 后任务变跳过状态。

- [ ] **Step 5: 跑全套测试

```bash
cd ~/.claude/skills/task-queue && node --test tests/*.test.cjs 2>&1 | tail -20
```

Expected: 100+ pass，0 fail。

- [ ] **Step 6: 更新 web/package.json 版本（如需）+ Commit + Tag**

```bash
cd ~/.claude/skills/task-queue
git add SKILL.md
git commit -m "task-queue v0.2.0 — 本地 Web 控制面板（多 project 聚合 + skip/priority/pause/resume + 任务级心跳）"
git tag -a v0.2.0 -m "task-queue v0.2.0 - dashboard"
git log --oneline -25
```

预期：tag v0.2.0 打到最新 commit，git log 显示 19 个 task 对应的 commit 序列。

---

## 自审清单（Self-Review）

### 1. Spec 覆盖

| Spec 节 | 对应 Task |
|---|---|
| §2 架构 | Task 11-15 |
| §3.1 数据流 lazy 读 | Task 12 |
| §3.2 文件锁 | Task 1, 2 |
| §3.3 心跳协议（任务级状态） | Task 6, 7 |
| §3.4 pause/resume + 不打断在跑 | Task 9, 10, 15 |
| §3.5 心跳容错 best-effort | Task 6（writeHeartbeat 返回 false 不抛） |
| §4.1 GET /api/projects | Task 12 |
| §4.2 GET /api/projects/:slug | Task 13 |
| §4.3 POST skip/priority/pause/resume | Task 14, 15 |
| §5 注册表 | Task 3, 4, 5 |
| §5.3 失联处理 (DELETE) | Task 15 |
| §6 前端 | Task 16, 17 |
| §7 启动入口 | Task 18 |
| §8 安全（loopback + slug 正则） | Task 11（host）, Task 13/14/15（SLUG_RE） |
| §11 验收 | Task 19 dry-run |

### 2. Placeholder 扫描

- 全文无 "TBD/TODO/implement later/fill in details"
- 每个 step 含完整代码或完整命令
- 测试代码含真实 assert

### 3. 类型一致性

- `writeHeartbeat(root, patch)` 签名贯穿 Task 6/7/8
- `startServer({port, host})` 签名 Task 11 定义、Task 18 调用一致
- `registry.add/remove/list` 函数名贯穿 Task 3/4/5/15
- `SLUG_RE`, `VALID_PRIORITIES` 在 Task 13/14 第一次出现后复用
- 心跳字段命名：`phase`/`currentTaskId`/`currentTaskDesc`/`lastFinishedId`/`lastFinishedAt` 在 spec §3.3 定义后所有 task 一致

### 4. 风险点

- **Task 10 status.cjs 改动**：Task 9 先让 loop-prompt Step 0.5 依赖 status 输出 paused，但 status 改动放在 Task 10。Task 9 完成时 status 还没改 → loop-prompt 段落仍然 OK（只是新功能未实装）。可接受，因为 loop-prompt 修改本身不会让现有功能失败。

- **Task 7 done.cjs 改动较大**：transitionToReview 加了两个参数，所有调用处都要改。需要 spec reviewer 仔细核对每处调用。

- **Task 17 手工冒烟**：app.js 没单元测试（DOM 操作难测），仅手工预演。dashboard-server.api.test.cjs 已覆盖后端 API。

---

## 执行交接

Plan 完整且自审通过，保存于 `~/.claude/skills/task-queue/docs/plans/2026-05-21-task-queue-dashboard.md`。

**两种执行方式**：

**1. Subagent-Driven（推荐）** — 我每个 task 派一个 fresh 子代理（implementer + spec 审 + 质量审），减少上下文污染。

**2. Inline Execution** — 在当前会话顺序跑，每 3-4 个 task 做一次 checkpoint review。
