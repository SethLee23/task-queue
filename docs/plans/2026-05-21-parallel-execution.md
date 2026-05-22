# task-queue 并行执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/loop` 主会话在一轮里并发派多个 subagent 执行不同任务,每条任务在独立 git worktree 里改代码 + build,主进程串行 merge 回 main。

**Architecture:** 主 Claude 进程 = 编排器(读 Excel、plan-batch、claim-batch、worktree 生命周期、串行 merge、推送、调度);subagent = 工作者(只在自己的 worktree 内改代码 + build + done-in-worktree)。隔离手段:每任务一临时 worktree,node_modules 用 symlink 复用主仓库。互斥手段:同 scope 默认串行 + 主 Claude 看 desc/note 在同 scope 内可放行独立任务;rebase 冲突一律转 review。

**Tech Stack:** Node 18+, ExcelJS 4.x,`node:test`,`git worktree`,`fs.symlinkSync`,mkdir-based 文件锁(`lib/lock.cjs` 已存在)。

## 文件结构

### 新建
- `lib/orchestrator.cjs` — `planBatch(rows, opts)` 纯规则函数
- `lib/worktree.cjs` — git worktree 生命周期 + symlink node_modules
- `lib/done-core.cjs` — 从 `commands/done.cjs` 抽出的核心 commit 逻辑(版本号 / changelog / commit message)
- `commands/plan-batch.cjs` — Step 1.5 候选输出
- `commands/claim-batch.cjs` — 原子批量 claim
- `commands/done-in-worktree.cjs` — subagent 在 worktree 内调用
- `commands/merge-task.cjs` — 主进程串行 merge
- `commands/worktree-list.cjs` — 列出当前 worktrees
- `commands/worktree-discard.cjs` — 强制销毁 worktree + 分支
- `tests/lib.orchestrator.test.cjs`
- `tests/lib.worktree.test.cjs`
- `tests/commands.plan-batch.test.cjs`
- `tests/commands.claim-batch.test.cjs`
- `tests/commands.done-in-worktree.test.cjs`
- `tests/commands.merge-task.test.cjs`
- `tests/commands.worktree-mgmt.test.cjs`
- `tests/integration.parallel-happy.test.cjs`
- `tests/integration.parallel-faults.test.cjs`

### 修改
- `lib/config.cjs` — 解析可选 `parallel: { enabled, maxConcurrency, allowSameScope }`
- `lib/heartbeat.cjs` — `currentTaskIds: number[]`,read 时向后兼容旧 `currentTaskId`
- `commands/next.cjs` — 加 `--limit N`,默认 1
- `commands/recover.cjs` — 扫 worktree orphan,按矩阵处理
- `commands/done.cjs` — 把可复用逻辑搬到 `lib/done-core.cjs`,行为不变
- `tasks.cjs` — 注册新命令
- `loop-prompt.md` — Step 1.5 + Step 3 派多 Agent + Step 4 串行 merge
- `web/dashboard*` — `currentTaskIds[]` 多任务展示
- `tests/_helpers.cjs` — 加 `setupGitProject(rows)` 工厂

---

## Task 1: 扩展测试 helpers,提供 git 项目工厂

**Files:**
- Modify: `tests/_helpers.cjs`
- Test: 由后续任务的 worktree 测试间接覆盖

- [ ] **Step 1:** 在 `tests/_helpers.cjs` 末尾追加 `setupGitProject` 工厂,导出。

代码追加到 `tests/_helpers.cjs`(在 `module.exports` 之前):

```javascript
const { execFileSync } = require('node:child_process');

/**
 * 创建一个 tmp git 项目,init 仓库 + 写一个初始 commit,.tasks/tasks.xlsx 按 rows 填充。
 * 用于需要真实 git 历史的测试(worktree / merge / recover orphan)。
 * @param {string} prefix mkdtemp 前缀
 * @returns {{ tmpDir: string, setupProject: (rows: object[]) => Promise<string> }}
 */
function createTmpGitProjectFactory(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  async function setupProject(rows) {
    const proj = fs.mkdtempSync(path.join(tmpDir, 'gitproj-'));
    // init git
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: proj });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: proj });
    // 写一个真实文件 + 初始 commit,这样 main 有 ref
    fs.writeFileSync(path.join(proj, 'README.md'), '# test\n');
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.1' }, null, 2));
    execFileSync('git', ['add', '.'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: proj });
    // 建空 node_modules 目录(给 symlink 用)
    fs.mkdirSync(path.join(proj, 'node_modules'));
    // .tasks
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
```

最后导出加上 `createTmpGitProjectFactory`:

```javascript
module.exports = { createTmpProjectFactory, createTmpGitProjectFactory, captureStdout };
```

- [ ] **Step 2:** 运行现有测试套件,验证未破坏。

```bash
cd ~/.claude/skills/task-queue && npm test
```

Expected: 所有现有 test 仍 PASS(本步骤纯追加,不改动现存代码)。

- [ ] **Step 3:** Commit

```bash
cd ~/.claude/skills/task-queue
git add tests/_helpers.cjs
git commit -m "test: 加 setupGitProject 工厂供 worktree/merge 测试用"
```

---

## Task 2: 解析 project.config.js 的 parallel 字段

**Files:**
- Modify: `lib/config.cjs`
- Test: `tests/config.test.cjs`(扩展)

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.cjs` 末尾追加:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadProjectConfig } = require('../lib/config.cjs');

test('parallel 字段缺失时返回默认 disabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-parallel-'));
  fs.mkdirSync(path.join(dir, '.tasks'));
  fs.writeFileSync(path.join(dir, '.tasks', 'project.config.js'), `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true' },
      versionFiles: { web: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md' },
      inferModule: () => 'm',
      commitMessage: () => 'msg',
    };
  `);
  const cfg = loadProjectConfig(dir);
  assert.deepEqual(cfg.parallel, { enabled: false, maxConcurrency: 3, allowSameScope: false });
});

test('parallel 字段存在时合并默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-parallel2-'));
  fs.mkdirSync(path.join(dir, '.tasks'));
  fs.writeFileSync(path.join(dir, '.tasks', 'project.config.js'), `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true' },
      versionFiles: { web: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md' },
      inferModule: () => 'm',
      commitMessage: () => 'msg',
      parallel: { enabled: true, maxConcurrency: 5 },
    };
  `);
  const cfg = loadProjectConfig(dir);
  assert.equal(cfg.parallel.enabled, true);
  assert.equal(cfg.parallel.maxConcurrency, 5);
  assert.equal(cfg.parallel.allowSameScope, false);  // 缺失字段填默认
});
```

- [ ] **Step 2: 运行,确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/config.test.cjs
```

Expected: FAIL,"cfg.parallel" 等于 undefined。

- [ ] **Step 3: 实现 — 修改 `lib/config.cjs`**

在 `loadProjectConfig` 函数返回前插入默认填充逻辑:

```javascript
// 在 for (const field of REQUIRED_FIELDS) 校验循环之后,return cfg 之前插入:
cfg.parallel = {
  enabled: false,
  maxConcurrency: 3,
  allowSameScope: false,
  ...(cfg.parallel || {}),
};
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/config.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/config.cjs tests/config.test.cjs
git commit -m "config: 加 parallel.{enabled,maxConcurrency,allowSameScope} 默认值合并"
```

---

## Task 3: orchestrator.planBatch 纯规则函数

**Files:**
- Create: `lib/orchestrator.cjs`
- Create: `tests/lib.orchestrator.test.cjs`

- [ ] **Step 1: 写失败测试**

新建 `tests/lib.orchestrator.test.cjs`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planBatch } = require('../lib/orchestrator.cjs');

const ROWS = [
  { id: 7, desc: '改登录页 i18n', scope: 'poc-web', note: '' },
  { id: 8, desc: 'fix 抽屉重复按钮', scope: 'poc-web', note: '' },
  { id: 9, desc: 'AuthController 401', scope: 'service-java', note: '' },
  { id: 10, desc: 'AuthController audit', scope: 'service-java', note: '' },
];

test('scopeMutex 自动按 scope 分组,跨 scope 不算互斥', () => {
  const { scopeMutex } = planBatch(ROWS, { maxConcurrency: 3, allowSameScope: false });
  // 同 scope 的两两都应在 scopeMutex 里
  assert.ok(scopeMutex.some(p => p.includes(7) && p.includes(8)));
  assert.ok(scopeMutex.some(p => p.includes(9) && p.includes(10)));
  // 跨 scope 不该出现
  assert.ok(!scopeMutex.some(p => p.includes(7) && p.includes(9)));
});

test('allowSameScope=false 时,同 scope 内只能挑一条', () => {
  const { parallel } = planBatch(ROWS, { maxConcurrency: 3, allowSameScope: false });
  const scopes = parallel.map(r => r.scope);
  // 每个 scope 在 parallel 里最多出现一次
  assert.equal(new Set(scopes).size, scopes.length);
});

test('maxConcurrency 严格上限', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: i, desc: `t${i}`, scope: `s${i}`, note: '',
  }));
  const { parallel } = planBatch(many, { maxConcurrency: 3, allowSameScope: false });
  assert.equal(parallel.length, 3);
});

test('note 含 "依赖 #N" 标识时,该任务不入并行批(必须等前置完成)', () => {
  const rows = [
    { id: 1, desc: 'a', scope: 'web', note: '' },
    { id: 2, desc: 'b', scope: 'service', note: '依赖 #1' },
  ];
  const { parallel, deferred } = planBatch(rows, { maxConcurrency: 3, allowSameScope: false });
  assert.deepEqual(parallel.map(r => r.id), [1]);
  assert.deepEqual(deferred.map(r => r.id), [2]);
});

test('candidates 为空时返回空数组,不抛错', () => {
  const r = planBatch([], { maxConcurrency: 3, allowSameScope: false });
  assert.deepEqual(r.parallel, []);
  assert.deepEqual(r.deferred, []);
  assert.deepEqual(r.scopeMutex, []);
});
```

- [ ] **Step 2: 运行,确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.orchestrator.test.cjs
```

Expected: FAIL,"Cannot find module '../lib/orchestrator.cjs'"。

- [ ] **Step 3: 实现 `lib/orchestrator.cjs`**

```javascript
'use strict';

/**
 * 根据规则把候选任务分成"本轮并行"和"推迟下轮"。
 * 不调 LLM,只做机械规则:
 *   1. allowSameScope=false 时同 scope 只取一条
 *   2. note 里含 "依赖 #N" 的任务,必须等 #N 在本批之外
 *   3. maxConcurrency 截断
 *
 * @param {Array<{id:number,desc:string,scope:string,note:string}>} rows 候选任务(已按优先级排好)
 * @param {{maxConcurrency:number, allowSameScope:boolean}} opts
 * @returns {{parallel:Array, deferred:Array, scopeMutex:Array<[number,number]>}}
 */
function planBatch(rows, opts) {
  const { maxConcurrency, allowSameScope } = opts;
  const scopeMutex = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].scope === rows[j].scope) scopeMutex.push([rows[i].id, rows[j].id]);
    }
  }

  const parallel = [];
  const deferred = [];
  const seenScopes = new Set();
  const dependsOn = (note) => {
    const m = String(note || '').match(/依赖\s*#(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const idsInBatch = new Set();

  for (const row of rows) {
    if (parallel.length >= maxConcurrency) {
      deferred.push(row);
      continue;
    }
    if (!allowSameScope && seenScopes.has(row.scope)) {
      deferred.push(row);
      continue;
    }
    const dep = dependsOn(row.note);
    if (dep != null && !idsInBatch.has(dep)) {
      // 前置不在本批 → 推迟(即便前置已完成也推迟,简化为下轮再 plan)
      deferred.push(row);
      continue;
    }
    parallel.push(row);
    idsInBatch.add(row.id);
    seenScopes.add(row.scope);
  }

  return { parallel, deferred, scopeMutex };
}

module.exports = { planBatch };
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.orchestrator.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/orchestrator.cjs tests/lib.orchestrator.test.cjs
git commit -m "orchestrator: planBatch 规则函数(scope 互斥 + 依赖 + 并发上限)"
```

---

## Task 4: heartbeat 升级 currentTaskIds[] 数组

**Files:**
- Modify: `lib/heartbeat.cjs`
- Test: `tests/lib.heartbeat.test.cjs`(扩展)

- [ ] **Step 1: 写失败测试**

在 `tests/lib.heartbeat.test.cjs` 末尾追加:

```javascript
test('writeHeartbeat 接受 currentTaskIds 数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-arr-'));
  fs.mkdirSync(path.join(dir, '.tasks', 'run'), { recursive: true });
  writeHeartbeat(dir, { phase: 'executing', currentTaskIds: [7, 9] });
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, [7, 9]);
});

test('readHeartbeat 回旧 schema(单 id) → 自动升为数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-compat-'));
  fs.mkdirSync(path.join(dir, '.tasks', 'run'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tasks', 'run', 'heartbeat.json'), JSON.stringify({
    phase: 'executing', currentTaskId: 5, model: 'x', ts: '2026-01-01T00:00:00Z',
  }));
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, [5]);
});

test('writeHeartbeat patch.currentTaskId 单字段也能写入,并升级成数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-upgrade-'));
  fs.mkdirSync(path.join(dir, '.tasks', 'run'), { recursive: true });
  writeHeartbeat(dir, { phase: 'executing', currentTaskId: 11 });
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, [11]);
});
```

(注意:文件顶部应已有 `const { writeHeartbeat, readHeartbeat } = require(...)` 和 fs/path/os 等 import,如缺则补)

- [ ] **Step 2: 运行,确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.heartbeat.test.cjs
```

Expected: FAIL,新测试中 currentTaskIds 是 undefined。

- [ ] **Step 3: 实现 — 改 `lib/heartbeat.cjs`**

替换文件内容:

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function heartbeatPath(projectRoot) {
  return path.join(projectRoot, '.tasks', 'run', 'heartbeat.json');
}

function normalizeIds(obj) {
  if (Array.isArray(obj.currentTaskIds)) return obj.currentTaskIds;
  if (obj.currentTaskId != null) return [obj.currentTaskId];
  return [];
}

function readHeartbeat(projectRoot) {
  const p = heartbeatPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    raw.currentTaskIds = normalizeIds(raw);
    return raw;
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
      model: patch.model || process.env.CLAUDE_MODEL || prev.model || 'unknown',
    };
    // 单 id 升级 / 显式数组保持
    next.currentTaskIds = normalizeIds(next);
    // 旧字段不再 persist,清掉,避免双源
    delete next.currentTaskId;
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { writeHeartbeat, readHeartbeat, heartbeatPath };
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.heartbeat.test.cjs tests/commands.heartbeat.test.cjs tests/heartbeat-integration.test.cjs
```

Expected: 所有 PASS(旧 currentTaskId 测试若有应同时通过;若旧测试断言 `currentTaskId` 字段在文件里,需改成断言 `currentTaskIds[0]`)。

- [ ] **Step 5: 调整 dashboard-server 读取逻辑**

`web/dashboard-server` 相关位置(`commands/dashboard-server.cjs` + UI 模板)凡读 `currentTaskId` 的,改读 `currentTaskIds[0]` 兼容旧;UI 改在 Task 16。

Search:
```bash
cd ~/.claude/skills/task-queue && grep -n "currentTaskId" commands/dashboard-server.cjs web/ -r
```

对每一处:把 `hb.currentTaskId` 改成 `(hb.currentTaskIds && hb.currentTaskIds[0])`。

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/heartbeat.cjs commands/dashboard-server.cjs web/ tests/lib.heartbeat.test.cjs
git commit -m "heartbeat: currentTaskIds 数组 schema + 旧字段兼容读"
```

---

## Task 5: worktree.createForTask

**Files:**
- Create: `lib/worktree.cjs`
- Create: `tests/lib.worktree.test.cjs`

- [ ] **Step 1: 写失败测试**

新建 `tests/lib.worktree.test.cjs`:

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTmpGitProjectFactory } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('wt-create-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('createForTask 在 .tasks/worktrees/task-N 创建 worktree + 拉 task-N 分支', async () => {
  const proj = await setupProject([]);
  const { worktreePath, branch } = createForTask(proj, 7);
  assert.equal(worktreePath, path.join(proj, '.tasks', 'worktrees', 'task-7'));
  assert.equal(branch, 'task-7');
  assert.ok(fs.existsSync(worktreePath));
  // 该 worktree 应处于 task-7 分支
  const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }).toString().trim();
  assert.equal(head, 'task-7');
});

test('createForTask 给 worktree 内 node_modules 建 symlink 指向主仓库', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 11);
  const nm = path.join(worktreePath, 'node_modules');
  const stat = fs.lstatSync(nm);
  assert.ok(stat.isSymbolicLink(), 'node_modules 应为 symlink');
  const target = fs.readlinkSync(nm);
  assert.ok(target.endsWith('node_modules'), `symlink 目标应指向 node_modules,实际 ${target}`);
});

test('createForTask 重复同 id 抛错', async () => {
  const proj = await setupProject([]);
  createForTask(proj, 3);
  assert.throws(() => createForTask(proj, 3), /已存在|exists/i);
});
```

- [ ] **Step 2: 运行,确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.worktree.test.cjs
```

Expected: FAIL,"Cannot find module '../lib/worktree.cjs'"。

- [ ] **Step 3: 实现(初始版,只 createForTask)`lib/worktree.cjs`**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function worktreeRoot(projectRoot) {
  return path.join(projectRoot, '.tasks', 'worktrees');
}

function worktreePathFor(projectRoot, taskId) {
  return path.join(worktreeRoot(projectRoot), `task-${taskId}`);
}

function branchFor(taskId) {
  return `task-${taskId}`;
}

/**
 * 创建任务专属 worktree,从 main 拉新分支 task-N,并把 node_modules symlink 到主仓库。
 * @param {string} projectRoot 项目根
 * @param {number|string} taskId
 * @param {string} [baseBranch] 默认 main
 * @returns {{worktreePath:string, branch:string}}
 */
function createForTask(projectRoot, taskId, baseBranch = 'main') {
  const wtPath = worktreePathFor(projectRoot, taskId);
  const branch = branchFor(taskId);
  if (fs.existsSync(wtPath)) {
    throw new Error(`worktree 已存在: ${wtPath}`);
  }
  fs.mkdirSync(worktreeRoot(projectRoot), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, wtPath, baseBranch], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // symlink node_modules
  const srcNm = path.join(projectRoot, 'node_modules');
  if (fs.existsSync(srcNm)) {
    const dstNm = path.join(wtPath, 'node_modules');
    if (fs.existsSync(dstNm)) {
      // 罕见,worktree 是从干净 main 拉的,不该有
      fs.rmSync(dstNm, { recursive: true, force: true });
    }
    try {
      fs.symlinkSync(path.relative(wtPath, srcNm), dstNm, 'dir');
    } catch (_) {
      // OS 不支持 symlink → hard-link 退路(暂不实现深复制,先抛)
      try {
        fs.linkSync(srcNm, dstNm);
      } catch (e2) {
        // 都不行就 fail,让调用方决定
        throw new Error(`无法为 worktree 创建 node_modules 链接: ${e2.message}`);
      }
    }
  }
  return { worktreePath: wtPath, branch };
}

module.exports = { createForTask, worktreePathFor, branchFor, worktreeRoot };
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.worktree.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/worktree.cjs tests/lib.worktree.test.cjs
git commit -m "worktree: createForTask 建 worktree + 拉 task-N 分支 + symlink node_modules"
```

---

## Task 6: worktree.destroyForTask

**Files:**
- Modify: `lib/worktree.cjs`
- Modify: `tests/lib.worktree.test.cjs`

- [ ] **Step 1: 追加失败测试**

在 `tests/lib.worktree.test.cjs` 末尾追加:

```javascript
const { destroyForTask } = require('../lib/worktree.cjs');

test('destroyForTask 删 worktree 目录 + 默认保留分支', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 21);
  destroyForTask(proj, 21);
  assert.ok(!fs.existsSync(worktreePath));
  // 分支应仍存在
  const branches = execFileSync('git', ['branch'], { cwd: proj }).toString();
  assert.ok(branches.includes('task-21'), '分支应保留');
});

test('destroyForTask deleteBranch=true 同时删分支', async () => {
  const proj = await setupProject([]);
  createForTask(proj, 22);
  destroyForTask(proj, 22, { deleteBranch: true });
  const branches = execFileSync('git', ['branch'], { cwd: proj }).toString();
  assert.ok(!branches.includes('task-22'), '分支应被删');
});

test('destroyForTask force=true 即使 worktree 内有未提交改动也能删', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 23);
  fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'unstaged');
  destroyForTask(proj, 23, { force: true });
  assert.ok(!fs.existsSync(worktreePath));
});

test('destroyForTask 目标不存在时静默成功(幂等)', async () => {
  const proj = await setupProject([]);
  destroyForTask(proj, 999);  // 不抛
});
```

- [ ] **Step 2: 运行,确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.worktree.test.cjs
```

Expected: FAIL,"destroyForTask is not a function"。

- [ ] **Step 3: 实现 — 在 `lib/worktree.cjs` 追加**

```javascript
/**
 * 删除任务 worktree,可选删分支。幂等(目标不存在不抛)。
 * @param {string} projectRoot
 * @param {number|string} taskId
 * @param {{force?:boolean, deleteBranch?:boolean}} [opts]
 */
function destroyForTask(projectRoot, taskId, opts = {}) {
  const wtPath = worktreePathFor(projectRoot, taskId);
  const branch = branchFor(taskId);
  if (fs.existsSync(wtPath)) {
    const args = ['worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push(wtPath);
    try {
      execFileSync('git', args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // 兜底:strong delete
      fs.rmSync(wtPath, { recursive: true, force: true });
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot });
      } catch (_) {}
    }
  }
  if (opts.deleteBranch) {
    try {
      execFileSync('git', ['branch', '-D', branch], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) {
      // 分支不存在,忽略
    }
  }
}

module.exports = { createForTask, destroyForTask, worktreePathFor, branchFor, worktreeRoot };
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.worktree.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/worktree.cjs tests/lib.worktree.test.cjs
git commit -m "worktree: destroyForTask 幂等删除 + 可选删分支"
```

---

## Task 7: worktree.listOrphans

**Files:**
- Modify: `lib/worktree.cjs`
- Modify: `tests/lib.worktree.test.cjs`

- [ ] **Step 1: 追加失败测试**

```javascript
const { listOrphans } = require('../lib/worktree.cjs');

test('listOrphans 列出所有 task-N worktree 及分支是否已 merge', async () => {
  const proj = await setupProject([]);
  createForTask(proj, 100);
  createForTask(proj, 101);
  // 在 task-101 上做个 commit 并 merge 回 main
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-101', 'a.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: path.join(proj, '.tasks', 'worktrees', 'task-101') });
  execFileSync('git', ['commit', '-q', '-m', 'wip'], { cwd: path.join(proj, '.tasks', 'worktrees', 'task-101') });
  execFileSync('git', ['merge', '--ff-only', 'task-101'], { cwd: proj });
  const orphans = listOrphans(proj);
  const byId = Object.fromEntries(orphans.map(o => [o.taskId, o]));
  assert.equal(byId[100].branchMerged, false);
  assert.equal(byId[101].branchMerged, true);
});

test('listOrphans 没 worktree 时返回空数组', async () => {
  const proj = await setupProject([]);
  assert.deepEqual(listOrphans(proj), []);
});
```

- [ ] **Step 2: 确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.worktree.test.cjs
```

Expected: FAIL,"listOrphans is not a function"。

- [ ] **Step 3: 实现 — 追加到 `lib/worktree.cjs`**

```javascript
/**
 * 列出 .tasks/worktrees 下所有 task-N 目录及对应分支 merge 状态。
 * @param {string} projectRoot
 * @param {string} [baseBranch] 默认 main
 * @returns {Array<{taskId:number, worktreePath:string, branch:string, branchMerged:boolean}>}
 */
function listOrphans(projectRoot, baseBranch = 'main') {
  const root = worktreeRoot(projectRoot);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root)
    .map(name => {
      const m = name.match(/^task-(\d+)$/);
      return m ? { name, taskId: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean);
  // 取所有已 merge 到 baseBranch 的 branch 名
  let mergedBranches = new Set();
  try {
    const out = execFileSync('git', ['branch', '--merged', baseBranch], { cwd: projectRoot }).toString();
    mergedBranches = new Set(
      out.split('\n')
        .map(s => s.replace(/^\*?\s+/, '').trim())
        .filter(Boolean),
    );
  } catch (_) {}
  return entries.map(e => ({
    taskId: e.taskId,
    worktreePath: path.join(root, e.name),
    branch: branchFor(e.taskId),
    branchMerged: mergedBranches.has(branchFor(e.taskId)),
  }));
}

module.exports = { createForTask, destroyForTask, listOrphans, worktreePathFor, branchFor, worktreeRoot };
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/lib.worktree.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/worktree.cjs tests/lib.worktree.test.cjs
git commit -m "worktree: listOrphans 列 task-N worktree + 分支 merge 状态"
```

---

## Task 8: commands/plan-batch.cjs

**Files:**
- Create: `commands/plan-batch.cjs`
- Create: `tests/commands.plan-batch.test.cjs`

- [ ] **Step 1: 写失败测试**

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const planBatchCmd = require('../commands/plan-batch.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('plan-batch-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const ROWS = [
  { id: 7, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:00:00Z' },
  { id: 8, desc: 'b', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
  { id: 9, desc: 'c', scope: 'service', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:02:00Z' },
];

function writeCfg(proj, parallel = {}) {
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true }, service: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true', service: 'true' },
      versionFiles: { web: 'package.json', service: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md', service: 'CHANGELOG.md' },
      inferModule: () => 'm',
      commitMessage: () => 'msg',
      parallel: ${JSON.stringify(parallel)},
    };
  `);
}

test('plan-batch 默认 limit=5,输出候选 + scopeMutex', async () => {
  const proj = await setupProject(ROWS);
  writeCfg(proj, { enabled: true, maxConcurrency: 3 });
  const out = await captureStdout(() => planBatchCmd(proj, []));
  const j = JSON.parse(out);
  assert.equal(j.candidates.length, 3);
  // scopeMutex 内含 [7,8]
  assert.ok(j.scopeMutex.some(p => p.includes(7) && p.includes(8)));
});

test('plan-batch --limit 2 截断', async () => {
  const proj = await setupProject(ROWS);
  writeCfg(proj, { enabled: true, maxConcurrency: 3 });
  const out = await captureStdout(() => planBatchCmd(proj, ['--limit', '2']));
  const j = JSON.parse(out);
  assert.equal(j.candidates.length, 2);
});

test('parallel.enabled=false 时返回空,提示走串行', async () => {
  const proj = await setupProject(ROWS);
  writeCfg(proj, { enabled: false });
  const out = await captureStdout(() => planBatchCmd(proj, []));
  const j = JSON.parse(out);
  assert.deepEqual(j.candidates, []);
  assert.match(j.reason || '', /未启用|disabled/);
});
```

- [ ] **Step 2: 确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.plan-batch.test.cjs
```

Expected: FAIL。

- [ ] **Step 3: 实现 `commands/plan-batch.cjs`**

```javascript
'use strict';

const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { sortByPriorityAndCtime } = require('../lib/sort.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');

/**
 * Step 1.5: 输出本轮可考虑的候选 + scope 互斥提示,供主 Claude 编排。
 * 不调 orchestrator.planBatch — 那是给 lib 内部的纯规则。这里只输出原料,让主 Claude
 * 看 desc/note 做语义判断,然后自己组装 claim-batch 调用。
 *
 * @param {string} projectRoot
 * @param {string[]} args 支持 --limit N
 */
module.exports = async function planBatch(projectRoot, args) {
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg.parallel.enabled) {
    process.stdout.write(JSON.stringify({
      candidates: [],
      scopeMutex: [],
      reason: 'parallel 未启用,走串行 next/claim 路径',
    }) + '\n');
    return;
  }

  let limit = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      limit = parseInt(args[i + 1], 10) || limit;
      i++;
    }
  }

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const todos = rows.filter(r => r.status === STATES.TODO);
  sortByPriorityAndCtime(todos);
  const candidates = todos.slice(0, limit).map(r => ({
    id: r.id,
    desc: r.desc,
    scope: r.scope,
    priority: r.priority,
    note: r.note,
  }));

  // scope 自相交 → mutex 提示
  const scopeMutex = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[i].scope === candidates[j].scope) {
        scopeMutex.push([candidates[i].id, candidates[j].id]);
      }
    }
  }

  process.stdout.write(JSON.stringify({
    candidates,
    scopeMutex,
    maxConcurrency: cfg.parallel.maxConcurrency,
    allowSameScope: cfg.parallel.allowSameScope,
  }) + '\n');
};
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.plan-batch.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/plan-batch.cjs tests/commands.plan-batch.test.cjs
git commit -m "plan-batch: 输出候选 + scopeMutex 供主 Claude 编排"
```

---

## Task 9: commands/claim-batch.cjs (原子批量 claim)

**Files:**
- Create: `commands/claim-batch.cjs`
- Create: `tests/commands.claim-batch.test.cjs`

- [ ] **Step 1: 写失败测试**

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const claimBatchCmd = require('../commands/claim-batch.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('claim-batch-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('claim-batch 把多条 id 同步标进行中', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'b', scope: 'svc', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  const out = await captureStdout(() => claimBatchCmd(proj, ['1', '2']));
  const j = JSON.parse(out);
  assert.equal(j.claimed.length, 2);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 1).status, '进行中');
  assert.equal(rows.find(r => r.id === 2).status, '进行中');
});

test('claim-batch 中途某条非待办 → 整批回滚', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'b', scope: 'svc', priority: '高', status: '已完成-待review', note: '', risk: 'x', ctime: '' },
  ]);
  await assert.rejects(() => claimBatchCmd(proj, ['1', '2']), /非法转换|状态/);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  // #1 没被改成进行中(整批回滚)
  assert.equal(rows.find(r => r.id === 1).status, '待办');
});

test('claim-batch 把 heartbeat.currentTaskIds 设为传入数组', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'b', scope: 'svc', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  fs.mkdirSync(path.join(proj, '.tasks', 'run'), { recursive: true });
  await claimBatchCmd(proj, ['1', '2']);
  const hb = JSON.parse(fs.readFileSync(path.join(proj, '.tasks', 'run', 'heartbeat.json'), 'utf8'));
  assert.deepEqual(hb.currentTaskIds.sort(), [1, 2]);
  assert.equal(hb.phase, 'executing');
});
```

- [ ] **Step 2: 确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.claim-batch.test.cjs
```

Expected: FAIL,模块未定义。

- [ ] **Step 3: 实现 `commands/claim-batch.cjs`**

```javascript
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex,
} = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');

/**
 * 原子批量 claim:一次拿 workbook 锁,把多个 id 同时标进行中。
 * 任何一条状态非法 → 抛错,本次 withWorkbook 整体回滚(没 commit 行)。
 *
 * @param {string} projectRoot
 * @param {string[]} args id 列表(数字字符串)
 */
module.exports = async function claimBatch(projectRoot, args) {
  if (!args || args.length === 0) throw new Error('claim-batch 需要至少 1 个 id');
  const ids = args.map(s => String(s));

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const targets = ids.map(id => {
    const r = rows.find(x => String(x.id) === id);
    if (!r) throw new Error(`未找到 id=${id} 的任务`);
    if (!canTransition(r.status, STATES.IN_PROGRESS)) {
      throw new Error(`非法转换:#${id} ${r.status} → 进行中`);
    }
    return r;
  });

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    for (const t of targets) {
      const row = ws.getRow(t._rowNumber);
      row.getCell(colIndex('status')).value = STATES.IN_PROGRESS;
      if (!t.ctime) row.getCell(colIndex('ctime')).value = new Date().toISOString();
      row.commit();
    }
  });

  writeHeartbeat(projectRoot, {
    phase: 'executing',
    currentTaskIds: targets.map(t => Number(t.id)),
  });

  process.stdout.write(JSON.stringify({
    claimed: targets.map(t => ({ id: t.id, desc: t.desc, scope: t.scope, note: t.note })),
  }) + '\n');
};
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.claim-batch.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/claim-batch.cjs tests/commands.claim-batch.test.cjs
git commit -m "claim-batch: 原子批量 claim + 写 currentTaskIds heartbeat"
```

---

## Task 10: 抽取 lib/done-core.cjs(零行为变更重构)

**Files:**
- Create: `lib/done-core.cjs`
- Modify: `commands/done.cjs`
- 现有 `tests/commands.done.test.cjs` 应继续通过

- [ ] **Step 1: 把 `commands/done.cjs` 里的可复用逻辑搬到 `lib/done-core.cjs`**

新建 `lib/done-core.cjs`:

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED, colIndex,
} = require('./workbook.cjs');
const { STATES } = require('./states.cjs');
const { gitStatus, gitAdd, gitCommit, gitLogToday } = require('./git.cjs');

function bumpPatchDefault(current) {
  const m = String(current).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`无法解析版本号: ${current}`);
  return `${m[1]}.${m[2]}.${parseInt(m[3], 10) + 1}${m[4]}`;
}

async function moveRowToArchive(xlsxPath, rowData) {
  await withWorkbook(xlsxPath, async wb => {
    const wsIn = wb.getWorksheet(SHEET_IN_PROGRESS);
    const wsArch = wb.getWorksheet(SHEET_ARCHIVED);
    const { _rowNumber, ...cleanRow } = rowData;
    wsArch.addRow(cleanRow);
    wsIn.spliceRows(_rowNumber, 1);
  });
}

async function setStatusAndRisk(xlsxPath, rowNumber, status, risk, ftime) {
  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const r = ws.getRow(rowNumber);
    r.getCell(colIndex('status')).value = status;
    if (risk != null) r.getCell(colIndex('risk')).value = risk;
    if (ftime != null) r.getCell(colIndex('ftime')).value = ftime;
    r.commit();
  });
}

/**
 * 给定一个已 in-progress 的 task 行 + scope 配置,执行 commit 阶段:
 * version bump / changelog / git add / git commit / 归档。
 * 失败回退转 review。
 *
 * @param {object} params
 * @returns {Promise<{commitSha?:string, version?:string, module?:string} | {review:true, risk:string}>}
 */
async function commitAndArchive({
  projectRoot, xlsxPath, target, scopeCfg, cfg, scopeName, logger,
}) {
  try {
    const changedFiles = gitStatus(projectRoot);
    if (changedFiles.length === 0) {
      target.status = STATES.DONE;
      target.ftime = new Date().toISOString();
      await moveRowToArchive(xlsxPath, target);
      logger?.info(`task #${target.id} done (无文件改动,已归档)`);
      return { commitSha: null, version: null, module: null };
    }
    const moduleName = cfg.inferModule(changedFiles, scopeName);
    if (moduleName == null) {
      await setStatusAndRisk(xlsxPath, target._rowNumber, STATES.REVIEW,
        '模块名推断失败,请补全 commit message 后改回待办', null);
      return { review: true, risk: '模块名推断失败' };
    }
    const versionFile = path.join(projectRoot, cfg.versionFiles[scopeName]);
    const pkg = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    const currentVersion = pkg.version;
    let version;
    const todayLog = gitLogToday(projectRoot);
    const escVer = currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versionUsedToday = new RegExp(`(?<![\\w.\\-])${escVer}(?![\\w.\\-])`).test(todayLog);
    if (cfg.sameDayShareVersion && versionUsedToday) {
      version = currentVersion;
    } else {
      version = (cfg.bumpVersion || bumpPatchDefault)(currentVersion);
      pkg.version = version;
      fs.writeFileSync(versionFile, JSON.stringify(pkg, null, 2) + '\n');
    }
    const changelogFile = path.join(projectRoot, cfg.changelogFiles[scopeName]);
    if (!fs.existsSync(changelogFile)) fs.writeFileSync(changelogFile, '');
    const changelogContent = fs.readFileSync(changelogFile, 'utf8');
    const entryLine = `【${moduleName}】${target.desc};`;
    const versionHeader = `## ${version}`;
    let newChangelog;
    if (changelogContent.includes(versionHeader)) {
      const escapedHeader = versionHeader.replace(/\./g, '\\.');
      newChangelog = changelogContent.replace(
        new RegExp(`(${escapedHeader}[^\\n]*\\n)`),
        (_, header) => `${header}${entryLine}\n`,
      );
    } else {
      newChangelog = `${versionHeader}\n${entryLine}\n\n${changelogContent}`;
    }
    fs.writeFileSync(changelogFile, newChangelog);
    const allChanged = gitStatus(projectRoot);
    gitAdd(projectRoot, allChanged);
    const commitMsg = cfg.commitMessage({
      scope: scopeName, module: moduleName, desc: target.desc, version,
    });
    gitCommit(projectRoot, commitMsg);
    target.status = STATES.DONE;
    target.ftime = new Date().toISOString();
    await moveRowToArchive(xlsxPath, target);
    logger?.info(`task #${target.id} done + commit ${version} 【${moduleName}】`);
    return { commitSha: null, version, module: moduleName };
  } catch (e) {
    const msg = (e.message || '').slice(0, 200);
    await setStatusAndRisk(xlsxPath, target._rowNumber, STATES.REVIEW,
      `commit 阶段失败:${msg}`, null);
    return { review: true, risk: msg };
  }
}

module.exports = { commitAndArchive, moveRowToArchive, setStatusAndRisk, bumpPatchDefault };
```

- [ ] **Step 2: 重写 `commands/done.cjs` 复用 done-core**

```javascript
'use strict';

const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { Logger } = require('../lib/logger.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
const { commitAndArchive, setStatusAndRisk } = require('../lib/done-core.cjs');

module.exports = async function done(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('done 需要 id 参数');
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const cfg = loadProjectConfig(projectRoot);
  const logger = new Logger(projectRoot);

  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);
  if (target.status !== STATES.IN_PROGRESS) {
    throw new Error(`非法转换:${target.status} → 已完成(必须先 claim)`);
  }

  const scopeName = target.scope;
  const scopeCfg = cfg.scopes[scopeName];
  if (!scopeCfg) {
    await setStatusAndRisk(xlsxPath, target._rowNumber, STATES.REVIEW,
      `未识别的 scope: ${scopeName}`, null);
    writeHeartbeat(projectRoot, { phase: 'idle', currentTaskIds: [], lastFinishedId: target.id, lastFinishedAt: new Date().toISOString() });
    return;
  }
  if (!scopeCfg.autoCommit) {
    await setStatusAndRisk(xlsxPath, target._rowNumber, STATES.REVIEW,
      `scope ${scopeName} 不允许自动 commit,请人工 review`, null);
    writeHeartbeat(projectRoot, { phase: 'idle', currentTaskIds: [], lastFinishedId: target.id, lastFinishedAt: new Date().toISOString() });
    return;
  }

  const result = await commitAndArchive({ projectRoot, xlsxPath, target, scopeCfg, cfg, scopeName, logger });
  writeHeartbeat(projectRoot, {
    phase: 'idle',
    currentTaskIds: [],
    lastFinishedId: target.id,
    lastFinishedAt: target.ftime || new Date().toISOString(),
  });
};
```

- [ ] **Step 3: 跑 done 现有测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.done.test.cjs
```

Expected: PASS — 行为应零变化(任何 done 现存测试断言都该满足)。

- [ ] **Step 4: 跑全套**

```bash
cd ~/.claude/skills/task-queue && npm test
```

Expected: all PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add lib/done-core.cjs commands/done.cjs
git commit -m "refactor: 抽 commitAndArchive 到 lib/done-core.cjs,done.cjs 复用"
```

---

## Task 11: commands/done-in-worktree.cjs

**Files:**
- Create: `commands/done-in-worktree.cjs`
- Create: `tests/commands.done-in-worktree.test.cjs`

- [ ] **Step 1: 写失败测试**

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const doneInWorktreeCmd = require('../commands/done-in-worktree.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('diw-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('done-in-worktree:无改动 → ok:true,无 commit,Excel 不动', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  createForTask(proj, 1);
  const out = await captureStdout(() => doneInWorktreeCmd(proj, ['1']));
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
  assert.equal(j.commitSha, null);
  // Excel 状态不变,仍进行中(主进程要在 merge-task 阶段处理状态)
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '进行中');
});

test('done-in-worktree:有正常改动 → commit 到 task-N 分支,ok:true,返回 sha', async () => {
  const proj = await setupProject([
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  const { worktreePath } = createForTask(proj, 2);
  fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello');
  const out = await captureStdout(() => doneInWorktreeCmd(proj, ['2']));
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
  assert.match(j.commitSha, /^[0-9a-f]{7,40}$/);
  // 主仓库 main 上不该看到这个 commit(隔离)
  const mainLog = execFileSync('git', ['log', '--oneline', 'main'], { cwd: proj }).toString();
  assert.ok(!mainLog.includes('feature.txt'));
});

test('done-in-worktree:改了 package.json → 拒绝 commit,ok:false', async () => {
  const proj = await setupProject([
    { id: 3, desc: 'c', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  const { worktreePath } = createForTask(proj, 3);
  fs.writeFileSync(path.join(worktreePath, 'package.json'),
    JSON.stringify({ name: 'test', version: '0.0.2', deps: 'changed' }, null, 2));
  const out = await captureStdout(() => doneInWorktreeCmd(proj, ['3']));
  const j = JSON.parse(out);
  assert.equal(j.ok, false);
  assert.match(j.reason, /依赖|package\.json/);
});

test('done-in-worktree:worktree 不存在 → 抛错', async () => {
  const proj = await setupProject([
    { id: 4, desc: 'd', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  await assert.rejects(() => doneInWorktreeCmd(proj, ['4']), /worktree.*不存在/);
});
```

- [ ] **Step 2: 确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.done-in-worktree.test.cjs
```

Expected: FAIL,模块未定义。

- [ ] **Step 3: 实现 `commands/done-in-worktree.cjs`**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { worktreePathFor, branchFor } = require('../lib/worktree.cjs');

const DEPS_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pom.xml'];

function changedFilesIn(wtPath) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: wtPath }).toString();
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.replace(/^\S+\s+/, ''));
}

/**
 * 在 worktree 内 commit(到自己的 task-N 分支)。不动 Excel,不动 main。
 * 改了依赖文件则拒绝 commit。
 * @param {string} projectRoot
 * @param {string[]} args args[0] = taskId
 */
module.exports = async function doneInWorktree(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('done-in-worktree 需要 id 参数');
  const wtPath = worktreePathFor(projectRoot, idArg);
  if (!fs.existsSync(wtPath)) {
    throw new Error(`worktree 不存在:${wtPath}`);
  }

  const changed = changedFilesIn(wtPath);
  if (changed.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, taskId: idArg, commitSha: null, changedFiles: [] }) + '\n');
    return;
  }

  // deps 文件保护
  const depsHit = changed.filter(f => DEPS_FILES.some(d => f === d || f.endsWith('/' + d)));
  if (depsHit.length > 0) {
    process.stdout.write(JSON.stringify({
      ok: false, taskId: idArg, reason: `并行模式禁止改依赖文件:${depsHit.join(', ')}`,
    }) + '\n');
    return;
  }

  execFileSync('git', ['add', '-A'], { cwd: wtPath });
  execFileSync('git', ['commit', '-q', '-m', `WIP task #${idArg}`], { cwd: wtPath });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath }).toString().trim();
  process.stdout.write(JSON.stringify({
    ok: true, taskId: idArg, commitSha: sha, changedFiles: changed,
  }) + '\n');
};
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.done-in-worktree.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/done-in-worktree.cjs tests/commands.done-in-worktree.test.cjs
git commit -m "done-in-worktree: subagent 在 worktree 内 WIP commit,deps 文件保护"
```

---

## Task 12: commands/merge-task.cjs

**Files:**
- Create: `commands/merge-task.cjs`
- Create: `tests/commands.merge-task.test.cjs`

- [ ] **Step 1: 写失败测试**

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const doneInWorktreeCmd = require('../commands/done-in-worktree.cjs');
const mergeTaskCmd = require('../commands/merge-task.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('merge-task-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeFullCfg(proj) {
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true' },
      versionFiles: { web: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md' },
      inferModule: () => 'web',
      commitMessage: ({ desc, version }) => 'web: ' + desc + ' v' + version,
      parallel: { enabled: true, maxConcurrency: 3, allowSameScope: false },
    };
  `);
}

async function setupReadyForMerge(rowOverrides) {
  const proj = await setupProject([{
    id: 1, desc: 'feat',scope: 'web', priority: '高',
    status: '进行中', note: '', ctime: '', ...rowOverrides,
  }]);
  writeFullCfg(proj);
  const { worktreePath } = createForTask(proj, 1);
  fs.writeFileSync(path.join(worktreePath, 'feat.txt'), 'hello');
  await captureStdout(() => doneInWorktreeCmd(proj, ['1']));
  return { proj, worktreePath };
}

test('merge-task ff-merge 成功路径:main 含 commit,worktree 删除,任务归档', async () => {
  const { proj, worktreePath } = await setupReadyForMerge();
  const out = await captureStdout(() => mergeTaskCmd(proj, ['1']));
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
  // main 上有这条 commit
  const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: proj }).toString();
  assert.match(log, /web: feat/);
  // worktree 已删
  assert.ok(!fs.existsSync(worktreePath));
  // Excel:从进行中移到已完结
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 0);
  assert.equal(arch[0].status, '已完成');
});

test('merge-task rebase 冲突 → 转 review,worktree 保留', async () => {
  // 步骤:先在 main 改 feat.txt 制造冲突源,再让任务 1 的 worktree commit 同文件
  const { proj, worktreePath } = await setupReadyForMerge();
  // 强制让 main 已经独立有冲突 commit:在主仓库改同名文件并 commit
  fs.writeFileSync(path.join(proj, 'feat.txt'), 'MAIN VERSION');
  execFileSync('git', ['add', 'feat.txt'], { cwd: proj });
  execFileSync('git', ['commit', '-q', '-m', 'main override'], { cwd: proj });

  const out = await captureStdout(() => mergeTaskCmd(proj, ['1']));
  const j = JSON.parse(out);
  assert.equal(j.ok, false);
  assert.match(j.reason, /冲突|conflict/i);
  // worktree 应保留
  assert.ok(fs.existsSync(worktreePath));
  // Excel:转 review
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(inProg[0].status, '已完成-待review');
});
```

- [ ] **Step 2: 确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.merge-task.test.cjs
```

Expected: FAIL,模块未定义。

- [ ] **Step 3: 实现 `commands/merge-task.cjs`**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { Logger } = require('../lib/logger.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
const { commitAndArchive, setStatusAndRisk } = require('../lib/done-core.cjs');
const { worktreePathFor, branchFor, destroyForTask } = require('../lib/worktree.cjs');

function tryFfMerge(projectRoot, branch) {
  try {
    execFileSync('git', ['merge', '--ff-only', branch], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (_) {
    return false;
  }
}

function tryRebase(worktreePath, baseBranch) {
  try {
    execFileSync('git', ['rebase', baseBranch], { cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (_) {
    // 中止 rebase 以保 worktree 状态可访问
    try { execFileSync('git', ['rebase', '--abort'], { cwd: worktreePath }); } catch (_) {}
    return false;
  }
}

/**
 * 主进程在 worktree commit 完成后调用,串行 merge 回 main。
 * 成功 → reset task 临时 commit + 走 done-core 的版本号/changelog/正式 commit + 归档 + 销毁 worktree。
 * Rebase 冲突 → 转 review,worktree 保留。
 *
 * @param {string} projectRoot
 * @param {string[]} args args[0] = taskId
 */
module.exports = async function mergeTask(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('merge-task 需要 id 参数');
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const cfg = loadProjectConfig(projectRoot);
  const logger = new Logger(projectRoot);
  const branch = branchFor(idArg);
  const wtPath = worktreePathFor(projectRoot, idArg);

  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);
  if (target.status !== STATES.IN_PROGRESS) {
    throw new Error(`非法转换:#${idArg} ${target.status} → 已完成`);
  }
  const scopeName = target.scope;
  const scopeCfg = cfg.scopes[scopeName];
  if (!scopeCfg || !scopeCfg.autoCommit) {
    await setStatusAndRisk(xlsxPath, target._rowNumber, STATES.REVIEW,
      `scope ${scopeName} 不允许自动 commit`, null);
    process.stdout.write(JSON.stringify({ ok: false, reason: 'scope 禁用 autoCommit' }) + '\n');
    return;
  }

  // 1) 尝试 ff-merge
  let merged = tryFfMerge(projectRoot, branch);
  if (!merged) {
    // 2) ff 失败 → rebase
    const rebaseOk = tryRebase(wtPath, 'main');
    if (rebaseOk) {
      merged = tryFfMerge(projectRoot, branch);
    }
  }
  if (!merged) {
    // 冲突路径:转 review,保留 worktree
    await setStatusAndRisk(xlsxPath, target._rowNumber, STATES.REVIEW,
      `merge 冲突,worktree 保留在 .tasks/worktrees/task-${idArg},解决后 merge-task ${idArg} 重试`, null);
    writeHeartbeat(projectRoot, {
      phase: 'idle', currentTaskIds: [],
      lastFinishedId: target.id, lastFinishedAt: new Date().toISOString(),
    });
    process.stdout.write(JSON.stringify({
      ok: false, taskId: idArg, reason: 'rebase 冲突,转 review 保留 worktree',
    }) + '\n');
    return;
  }

  // 3) ff-merge 成功:main 上现在有 task-N 的 WIP commit。回退它,让 done-core 重做版本号+正式 commit。
  // task-N 上只有一个 WIP commit;ff 后 main 落到 task-N HEAD。
  try {
    execFileSync('git', ['reset', '--mixed', 'HEAD^'], { cwd: projectRoot });
  } catch (_) {
    // 已经在 base 上,跳过
  }
  // 现在主仓库工作区是任务改动,index 也是,跑 done-core 的 commitAndArchive 走完整版本号/changelog 流程
  const result = await commitAndArchive({ projectRoot, xlsxPath, target, scopeCfg, cfg, scopeName, logger });
  writeHeartbeat(projectRoot, {
    phase: 'idle', currentTaskIds: [],
    lastFinishedId: target.id, lastFinishedAt: target.ftime || new Date().toISOString(),
  });

  if (result.review) {
    // commitAndArchive 内部已转 review,worktree 也保留
    process.stdout.write(JSON.stringify({ ok: false, taskId: idArg, reason: result.risk }) + '\n');
    return;
  }

  // 4) 成功 → 销毁 worktree + 删 task-N 分支
  destroyForTask(projectRoot, idArg, { force: true, deleteBranch: true });
  process.stdout.write(JSON.stringify({
    ok: true, taskId: idArg, version: result.version, module: result.module,
  }) + '\n');
};
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.merge-task.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/merge-task.cjs tests/commands.merge-task.test.cjs
git commit -m "merge-task: ff-merge / rebase / 冲突转 review,成功路径销毁 worktree"
```

---

## Task 13: worktree-list + worktree-discard 命令

**Files:**
- Create: `commands/worktree-list.cjs`
- Create: `commands/worktree-discard.cjs`
- Create: `tests/commands.worktree-mgmt.test.cjs`

- [ ] **Step 1: 写失败测试**

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const worktreeListCmd = require('../commands/worktree-list.cjs');
const worktreeDiscardCmd = require('../commands/worktree-discard.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('wt-mgmt-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('worktree-list 输出现有 worktree', async () => {
  const proj = await setupProject([]);
  createForTask(proj, 7);
  createForTask(proj, 9);
  const out = await captureStdout(() => worktreeListCmd(proj, []));
  const j = JSON.parse(out);
  assert.equal(j.worktrees.length, 2);
  const ids = j.worktrees.map(w => w.taskId).sort();
  assert.deepEqual(ids, [7, 9]);
});

test('worktree-discard 删 worktree + 删分支', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 11);
  await captureStdout(() => worktreeDiscardCmd(proj, ['11']));
  assert.ok(!fs.existsSync(worktreePath));
});
```

- [ ] **Step 2: 确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.worktree-mgmt.test.cjs
```

Expected: FAIL,模块未定义。

- [ ] **Step 3: 实现 `commands/worktree-list.cjs`**

```javascript
'use strict';
const { listOrphans } = require('../lib/worktree.cjs');

module.exports = async function worktreeList(projectRoot, _args) {
  const worktrees = listOrphans(projectRoot);
  process.stdout.write(JSON.stringify({ worktrees }) + '\n');
};
```

- [ ] **Step 4: 实现 `commands/worktree-discard.cjs`**

```javascript
'use strict';
const { destroyForTask } = require('../lib/worktree.cjs');

module.exports = async function worktreeDiscard(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('worktree-discard 需要 id 参数');
  destroyForTask(projectRoot, idArg, { force: true, deleteBranch: true });
  process.stdout.write(JSON.stringify({ ok: true, discarded: idArg }) + '\n');
};
```

- [ ] **Step 5: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.worktree-mgmt.test.cjs
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/worktree-list.cjs commands/worktree-discard.cjs tests/commands.worktree-mgmt.test.cjs
git commit -m "worktree mgmt: list + discard 命令"
```

---

## Task 14: next --limit N

**Files:**
- Modify: `commands/next.cjs`
- Modify: `tests/commands.next.test.cjs`

- [ ] **Step 1: 写失败测试**

在 `tests/commands.next.test.cjs` 末尾追加:

```javascript
test('next --limit 3 返回数组(最多 3 条)', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'w', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:00:00Z' },
    { id: 2, desc: 'b', scope: 'w', priority: '中', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
    { id: 3, desc: 'c', scope: 's', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:02:00Z' },
    { id: 4, desc: 'd', scope: 's', priority: '低', status: '待办', note: '', ctime: '2026-01-01T00:03:00Z' },
  ]);
  const out = await captureStdout(() => nextCmd(proj, ['--limit', '3']));
  const j = JSON.parse(out);
  assert.ok(Array.isArray(j));
  assert.equal(j.length, 3);
  // 按优先级排序:#1 高,#3 高,#2 中
  assert.deepEqual(j.map(r => r.id), [1, 3, 2]);
});

test('next 不带 --limit 时仍返回单 obj(向后兼容)', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'w', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:00:00Z' },
  ]);
  const out = await captureStdout(() => nextCmd(proj, []));
  const j = JSON.parse(out);
  assert.ok(!Array.isArray(j));
  assert.equal(j.id, 1);
});
```

- [ ] **Step 2: 确认失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.next.test.cjs
```

Expected: 新测试 FAIL,旧的 PASS。

- [ ] **Step 3: 改 `commands/next.cjs`**

```javascript
'use strict';

const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { sortByPriorityAndCtime } = require('../lib/sort.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');

module.exports = async function next(projectRoot, args) {
  let limit = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const todos = rows.filter(r => r.status === STATES.TODO);
  sortByPriorityAndCtime(todos);

  if (todos.length === 0) {
    writeHeartbeat(projectRoot, { phase: 'sleeping', currentTaskIds: [] });
    process.stdout.write((limit ? '[]' : 'null') + '\n');
    return;
  }

  if (limit) {
    const out = todos.slice(0, limit).map(r => {
      const { _rowNumber, ...rest } = r;
      return rest;
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  const picked = todos[0];
  const { _rowNumber, ...rest } = picked;
  process.stdout.write(JSON.stringify(rest) + '\n');
};
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.next.test.cjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/next.cjs tests/commands.next.test.cjs
git commit -m "next: 加 --limit N 返回数组,无参时保持单 obj 兼容"
```

---

## Task 15: recover 扫 worktree orphan

**Files:**
- Modify: `commands/recover.cjs`
- Modify: 对应测试

- [ ] **Step 1: 读取并理解现有 `commands/recover.cjs`**

```bash
cd ~/.claude/skills/task-queue && cat commands/recover.cjs
```

(理解它现在做什么:扫"进行中"sheet 把 IN_PROGRESS 卡住的任务挪回 todo)

- [ ] **Step 2: 写失败测试 — `tests/commands.misc.test.cjs` 末尾追加**

```javascript
test('recover 扫到 task-N orphan,分支未 merge → 任务转 review,保留 worktree', async () => {
  const { createTmpGitProjectFactory } = require('./_helpers.cjs');
  const { createForTask } = require('../lib/worktree.cjs');
  const recoverCmd = require('../commands/recover.cjs');
  const { tmpDir, setupProject } = createTmpGitProjectFactory('rec-orphan-');

  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  createForTask(proj, 1);  // worktree 存在但任务还在 todo → orphan
  await captureStdout(() => recoverCmd(proj, []));
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  // worktree 保留
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 3: 确认新测试失败**

```bash
cd ~/.claude/skills/task-queue && node --test tests/commands.misc.test.cjs
```

Expected: 新 orphan 测试 FAIL。

- [ ] **Step 4: 实现 — 在 `commands/recover.cjs` 末尾追加 orphan 处理**

(代码示例 — 实际 patch 要 splice 进现有 recover 函数末尾)

```javascript
// 在现有 recover() 返回前插入:
const { listOrphans, destroyForTask } = require('../lib/worktree.cjs');
const { setStatusAndRisk } = require('../lib/done-core.cjs');

async function handleOrphans(projectRoot) {
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const orphans = listOrphans(projectRoot);
  if (orphans.length === 0) return;
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  for (const o of orphans) {
    const task = rows.find(r => String(r.id) === String(o.taskId));
    if (!task) {
      // 任务被删 → 强删 worktree + 分支
      destroyForTask(projectRoot, o.taskId, { force: true, deleteBranch: true });
      continue;
    }
    if (task.status === STATES.REVIEW) continue;  // 预期状态,跳过
    if (task.status === STATES.DONE) {
      if (o.branchMerged) {
        destroyForTask(projectRoot, o.taskId, { force: true, deleteBranch: true });
      }
      // 已归档但未 merge:罕见,记 warn,保留 worktree 让用户看
      continue;
    }
    // todo / in_progress / blocked → 转 review
    await setStatusAndRisk(xlsxPath, task._rowNumber, STATES.REVIEW,
      `recover 发现 worktree task-${o.taskId} 与任务状态不一致,转 review`, null);
  }
}

// 现有 recover 函数主体末尾(返回前)插入一行:
await handleOrphans(projectRoot);
```

(具体 diff 取决于现有 recover 结构;主要逻辑就是上述)

- [ ] **Step 5: 跑测试**

```bash
cd ~/.claude/skills/task-queue && npm test
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/task-queue
git add commands/recover.cjs tests/commands.misc.test.cjs
git commit -m "recover: 扫 worktree orphan 按矩阵处理(不一致 → review,已归档已 merge → 清)"
```

---

## Task 16: tasks.cjs 注册新命令

**Files:**
- Modify: `tasks.cjs`

- [ ] **Step 1: 读现有 dispatcher**

```bash
cd ~/.claude/skills/task-queue && cat tasks.cjs
```

- [ ] **Step 2: 加新命令注册**

在 `tasks.cjs` 的命令分发表(类似 `const handlers = {...}` 段)里追加映射:

```javascript
'plan-batch':       require('./commands/plan-batch.cjs'),
'claim-batch':      require('./commands/claim-batch.cjs'),
'done-in-worktree': require('./commands/done-in-worktree.cjs'),
'merge-task':       require('./commands/merge-task.cjs'),
'worktree-list':    require('./commands/worktree-list.cjs'),
'worktree-discard': require('./commands/worktree-discard.cjs'),
```

- [ ] **Step 3: 手工 smoke test**

```bash
cd ~/.claude/skills/task-queue && node tasks.cjs plan-batch /tmp/nonexistent 2>&1 | head -5
```

Expected: 报错应该是"project.config.js 不存在"类(说明命令已加载,只是测试用了不存在的 path)。

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/task-queue
git add tasks.cjs
git commit -m "tasks.cjs: 注册 6 个并行相关命令"
```

---

## Task 17: 更新 loop-prompt.md

**Files:**
- Modify: `loop-prompt.md`

- [ ] **Step 1: 在现 Step 1 之前插入 Step 1.5**

读现有 loop-prompt.md,定位 Step 1:

```bash
cd ~/.claude/skills/task-queue && grep -n "Step 1: 取下一条任务" loop-prompt.md
```

- [ ] **Step 2: 修改 Step 1 区块**

把原 Step 1 的内容包成 "Step 1(串行模式)/Step 1(并行模式)"分支。

替换 Step 1 整段:

```markdown
## Step 1: 取下一条任务

先看 `.tasks/project.config.js` 的 `parallel.enabled`:

### Step 1a: 串行模式(parallel.enabled=false 或字段缺失)

```
node ~/.claude/skills/task-queue/tasks.cjs next ${PROJECT_ROOT}
```

- 输出 `null` → 跳到 Step 5
- 输出 JSON `{id, desc, scope, priority, note}` → 进入 Step 2(claim 单条)

### Step 1b: 并行模式(parallel.enabled=true)

```
node ~/.claude/skills/task-queue/tasks.cjs plan-batch ${PROJECT_ROOT}
```

输出:
```json
{
  "candidates": [{"id":7,"desc":"...","scope":"...","note":"..."}, ...],
  "scopeMutex": [[7,8],[9,10]],
  "maxConcurrency": 3,
  "allowSameScope": false
}
```

**编排规则**(你自己跑,不需要外部命令):

1. 默认同 scope 串行(`scopeMutex` 里的 pair 不能同时选)
2. `allowSameScope=true` 时,若 desc 看起来明显独立(改不同子目录/不同文件类型)可放进同批
3. note 里含 "依赖 #N" 时,#N 不在本批就推迟
4. 上限 `maxConcurrency` 条

在 stdout 写一行编排理由,例:
> "本轮并行 #7 #9,理由:跨 scope,desc 无目录重叠"

然后调用:

```
node ~/.claude/skills/task-queue/tasks.cjs claim-batch ${PROJECT_ROOT} <id1> <id2> ...
```

进入并行执行(下文 Step 3 改写)。
```

- [ ] **Step 3: 修改 Step 3 — 并行模式下派多 Agent**

在 Step 3 当前段落之前加一段:

```markdown
### Step 3(并行模式分支):派 Agent 并发执行

对每条 claim 到的 id,**先建 worktree**(主进程跑):

```
# Pseudocode,Claude 需对每个 id 跑一次:
git worktree add <PROJECT_ROOT>/.tasks/worktrees/task-<id> -b task-<id> main
ln -s ../../node_modules <PROJECT_ROOT>/.tasks/worktrees/task-<id>/node_modules
```

(实际由 Claude 调 Bash 工具执行)。

然后**同一条 message** 里发起多个 Agent 工具调用,每条任务一个 Agent,prompt 模板:

> "在 ${PROJECT_ROOT}/.tasks/worktrees/task-<id> 工作。任务 #<id>: <desc>。
> 编辑代码 → 跑 buildCommands[scope] 验证 → 完成后调
> `node ~/.claude/skills/task-queue/tasks.cjs done-in-worktree ${PROJECT_ROOT} <id>`。
> **不要**调 done 或 claim。**不要**改 package.json / 锁文件。"

收齐所有 Agent 返回后进入 Step 4。
```

- [ ] **Step 4: 修改 Step 4 — 并行模式串行 merge**

在 Step 4 现有内容前加并行分支:

```markdown
### Step 4(并行模式分支):按 claim 顺序串行 merge

对每条 task id(按 claim 顺序):

```
node ~/.claude/skills/task-queue/tasks.cjs merge-task ${PROJECT_ROOT} <id>
```

返回 `{ok: true}` → 该任务完成、worktree 已清。
返回 `{ok: false, reason: "..."}` → 转 review,worktree 保留供后续人工处理。

每条 merge-task 都跟一次 Step 4.5 推送(通道 A + 通道 B),内容反映该任务结果。
```

- [ ] **Step 5: 提交**

```bash
cd ~/.claude/skills/task-queue
git add loop-prompt.md
git commit -m "loop-prompt: 加并行模式分支(Step 1b/3 派 Agent/4 串行 merge)"
```

---

## Task 18: dashboard 多任务展示

**Files:**
- Modify: `web/*` 中 UI 模板与 dashboard-server.cjs 中渲染逻辑

- [ ] **Step 1: 定位 dashboard UI 渲染 currentTaskId 的位置**

```bash
cd ~/.claude/skills/task-queue && grep -rn "currentTaskId" web/ commands/dashboard-server.cjs
```

- [ ] **Step 2: 改渲染**

把单任务展示改成多任务展示:

- 模板里 `${currentTaskId}` → 遍历 `currentTaskIds` 用 `<ul>` 或逗号分隔
- dashboard-server 返回的 JSON 加 `currentTaskIds: hb.currentTaskIds || []`,旧 `currentTaskId` 字段保留(向后兼容 chrome 缓存版的 UI)
- CSS 适配,多条任务在窄面板下能换行

具体 patch 取决于现有模板结构;以现存代码为准。

- [ ] **Step 3: 单元测试 dashboard-server schema**

新建 `tests/dashboard-server.parallel-ids.test.cjs`(沿用 detail.test.cjs 的 startServer + registryAdd 模式):

```javascript
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../commands/dashboard-server.cjs');
const { add: registryAdd } = require('../lib/registry.cjs');
const { createBlankWorkbook } = require('../lib/workbook.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-parallel-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => { if (inst) await inst.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function mkProjWithHeartbeat(hbContent) {
  const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  fs.mkdirSync(path.join(p, '.tasks', 'run'), { recursive: true });
  await createBlankWorkbook(path.join(p, '.tasks', 'tasks.xlsx'));
  fs.writeFileSync(path.join(p, '.tasks', 'run', 'heartbeat.json'), JSON.stringify(hbContent));
  return p;
}

test('GET /api/projects/:slug 暴露 currentTaskIds 数组', async () => {
  const proj = await mkProjWithHeartbeat({
    phase: 'executing',
    currentTaskIds: [7, 9],
    model: 'claude-opus-4-7',
    ts: new Date().toISOString(),
  });
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  const body = await res.json();
  assert.deepEqual(body.heartbeat.currentTaskIds, [7, 9]);
});

test('GET /api/projects/:slug 读旧 schema currentTaskId → 自动升为数组', async () => {
  const proj = await mkProjWithHeartbeat({
    phase: 'executing',
    currentTaskId: 5,        // 旧字段
    model: 'claude-opus-4-7',
    ts: new Date().toISOString(),
  });
  const entry = registryAdd(proj);
  if (!inst) inst = await startServer({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/projects/${entry.slug}`);
  const body = await res.json();
  assert.deepEqual(body.heartbeat.currentTaskIds, [5]);
});
```

注意:Task 4 已让 `readHeartbeat` 自动升级旧字段。这两个测试验证 dashboard-server 端到端的暴露字段。
如果现有 `/api/projects/:slug` 返回的 `body.heartbeat` 字段名不同(例如包在 `body.project.heartbeat` 里),
按 detail.test.cjs 实际访问路径调整。

- [ ] **Step 4: 手工浏览器 smoke test**

```bash
cd ~/.claude/skills/task-queue && node tasks.cjs dashboard
```

打开浏览器,检查:
- 多任务并行时面板显示多个 desc(逗号或换行)
- 单任务时显示一个 desc(向后兼容)

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/task-queue
git add web/ commands/dashboard-server.cjs tests/
git commit -m "dashboard: 多任务并行时展示 currentTaskIds 数组"
```

---

## Task 19: e2e happy-path 集成测试

**Files:**
- Create: `tests/integration.parallel-happy.test.cjs`

- [ ] **Step 1: 写测试 — 用两个 scope 模拟 worker 子进程跑完整轮**

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const planBatchCmd = require('../commands/plan-batch.cjs');
const claimBatchCmd = require('../commands/claim-batch.cjs');
const mergeTaskCmd = require('../commands/merge-task.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('integ-happy-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('e2e: plan-batch → claim-batch → 2 个子进程模拟 subagent → merge-task ×2 → Excel 全归档', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'web 改', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:00:00Z' },
    { id: 2, desc: 'svc 改', scope: 'service', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
  ]);
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true }, service: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true', service: 'true' },
      versionFiles: { web: 'package.json', service: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md', service: 'CHANGELOG.md' },
      inferModule: (_, s) => s,
      commitMessage: ({ scope, desc, version }) => scope + ': ' + desc + ' v' + version,
      parallel: { enabled: true, maxConcurrency: 3, allowSameScope: false },
    };
  `);

  // Step 1.5 (skip stdout capture, just verify command runs)
  // Step 2: claim-batch
  await claimBatchCmd(proj, ['1', '2']);

  // Step 3: 创建 worktree + 子进程"做工作"
  createForTask(proj, 1);
  createForTask(proj, 2);
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-1', 'web.txt'), 'web work');
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-2', 'svc.txt'), 'svc work');
  // done-in-worktree 子进程
  for (const id of ['1', '2']) {
    const r = spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done-in-worktree', proj, id], { encoding: 'utf8' });
    assert.equal(r.status, 0, `done-in-worktree #${id} 应成功: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
  }

  // Step 4: 串行 merge
  for (const id of ['1', '2']) {
    await mergeTaskCmd(proj, [id]);
  }

  // 验证
  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 0);
  assert.equal(arch.length, 2);
  // worktree 全清
  assert.ok(!fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
  assert.ok(!fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-2')));
  // main 上两条 commit
  const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: proj }).toString();
  assert.match(log, /web:/);
  assert.match(log, /service:/);
});
```

- [ ] **Step 2: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/integration.parallel-happy.test.cjs
```

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/task-queue
git add tests/integration.parallel-happy.test.cjs
git commit -m "test: e2e 并行 happy path(plan/claim/worker/merge ×2)"
```

---

## Task 20: e2e 故障注入测试

**Files:**
- Create: `tests/integration.parallel-faults.test.cjs`

- [ ] **Step 1: 写测试 — 3 个故障注入场景**

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const claimBatchCmd = require('../commands/claim-batch.cjs');
const mergeTaskCmd = require('../commands/merge-task.cjs');
const recoverCmd = require('../commands/recover.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('integ-faults-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeCfg(proj) {
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true' },
      versionFiles: { web: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md' },
      inferModule: () => 'web',
      commitMessage: ({ desc, version }) => 'web: ' + desc + ' v' + version,
      parallel: { enabled: true, maxConcurrency: 3, allowSameScope: true },
    };
  `);
}

test('故障(a) 两 worker 改同文件 → 第二条 merge 冲突,转 review', async () => {
  const proj = await setupProject([
    { id: 1, desc: 't1', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 't2', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeCfg(proj);
  await claimBatchCmd(proj, ['1', '2']);
  createForTask(proj, 1);
  createForTask(proj, 2);
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-1', 'shared.txt'), 'v1');
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-2', 'shared.txt'), 'v2');
  for (const id of ['1', '2']) {
    const r = spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done-in-worktree', proj, id], { encoding: 'utf8' });
    assert.equal(r.status, 0);
  }
  await mergeTaskCmd(proj, ['1']);
  await mergeTaskCmd(proj, ['2']);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const t2 = rows.find(r => String(r.id) === '2');
  assert.equal(t2.status, '已完成-待review');
  // task-2 worktree 保留
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-2')));
});

test('故障(b) worker 改 package.json → done-in-worktree 拒绝', async () => {
  const proj = await setupProject([
    { id: 1, desc: 't1', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeCfg(proj);
  await claimBatchCmd(proj, ['1']);
  const { worktreePath } = createForTask(proj, 1);
  fs.writeFileSync(path.join(worktreePath, 'package.json'),
    JSON.stringify({ name: 'test', version: '0.0.2' }));
  const r = spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done-in-worktree', proj, '1'], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
});

test('故障(c) recover 清理 orphan worktree', async () => {
  const proj = await setupProject([
    { id: 1, desc: 't1', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeCfg(proj);
  // 模拟主进程崩溃留下的孤儿:worktree 存在,任务还在 todo
  createForTask(proj, 1);
  await recoverCmd(proj, []);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  // worktree 保留(因为还要让用户看)
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
});
```

- [ ] **Step 2: 跑测试**

```bash
cd ~/.claude/skills/task-queue && node --test tests/integration.parallel-faults.test.cjs
```

Expected: PASS。

- [ ] **Step 3: 跑全套**

```bash
cd ~/.claude/skills/task-queue && npm test
```

Expected: 所有 PASS(含原有 30+ 个测试 + 这一期新增的 ~10 个)。

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/task-queue
git add tests/integration.parallel-faults.test.cjs
git commit -m "test: e2e 故障注入(冲突 / deps 变更 / orphan recover)"
```

---

## Self-Review 后清单

完成 20 个任务后,Claude 工作者(或人工)做一遍清单核对:

- [ ] spec §1 架构图所有箭头都在某个 Task 里落地
- [ ] spec §2 表里"新建"8 个文件都有对应 Create Task
- [ ] spec §2 表里"修改"7 个文件都有对应 Modify Task
- [ ] spec §3.5 worktree 生命周期表 4 种"删/留"路径都有测试
- [ ] spec §4 异常表 9 种异常都有测试或代码兜底
- [ ] spec §5 测试策略里"单元 + 集成 + 故障注入 + dashboard 兼容 + 回归"全部落实
- [ ] `parallel.enabled=false` 时,跑全套测试无新失败(回归保护)

如发现 spec 有要求但没 Task 实现,补 Task 后再走 Self-Review。

---

## 备注:dashboard 详细 UI 改造

Task 18 故意写得宽泛 — dashboard 的实际 HTML/CSS 模板要看现有 `web/` 目录的具体技术栈(看 `web/dashboard-server.cjs` 是怎么吐 HTML 的)。执行时先调研一次,再决定是改模板字符串还是改单独的 .html / .js 文件。本计划无法预定具体行号。
