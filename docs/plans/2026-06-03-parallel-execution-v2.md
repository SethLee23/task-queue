# task-queue 并行执行 v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/loop` 主会话一轮并发派多个 subagent:code 任务在独立 git worktree 改代码,主 loop 串行 merge 回 main;non-code 任务不开 worktree、不碰 git,返回即归档。

**Architecture:** 主 loop = 编排器(plan-batch 候选 → LLM 标 lane/挑批次 → claim-batch 原子锁 → 建 worktree → 一条 message 派 K 个 Agent → non-code 即时 done、code 串行 merge-task → 推送/调度)。code worker 只在自己 worktree 改代码 + build + done-in-worktree(commit 到 task-N 分支),不碰 Excel。non-code worker 只读主仓库,产出写 `.tasks/reports/` 或返回正文。失败兜底一律转 review 保留 worktree;non-code 误改文件由 `done --expect-clean` 还原+review;needs-code 回流一次(requeue),二次转 review。

**Tech Stack:** Node 18+, ExcelJS 4.x, `node:test`, `git worktree`, `fs.symlinkSync`, mkdir 文件锁(`lib/lock.cjs` 已存在)。

**与 v1 plan(2026-05-21)的差异(执行者必读):**

1. 代码库已漂移:`loop-prompt.md` 现在是 subagent 派发模式(worker 自己 claim/done/推送);`done.cjs` 已带 summary 强制 + checklist 护栏 + `.tasks/` 过滤;`heartbeat` 已有 `currentTaskDesc`/`lastFinishedId` 字段。本 plan 所有代码块已对齐**当前** main(commit 4577b75)。
2. v1 的 `lib/orchestrator.cjs` 取消 —— 它的规则(scopeMutex 计算)只有 plan-batch 用,10 行内联即可,单独 lib 是过度设计(spec §4 已同步修订)。
3. 新增双 lane:`requeue` 命令(needs-code 回流)、`done --expect-clean`(non-code 脏检查)、`worktree-create` 命令(主 loop 不裸跑 git)。
4. base 分支不再硬编码 `main`,运行时解析主仓库当前 HEAD 分支。

## 文件结构

### 新建
- `lib/worktree.cjs` — worktree 生命周期 + symlink node_modules + 默认分支解析
- `lib/done-core.cjs` — 从 `commands/done.cjs` 抽出的 commit/归档/转 review 核心(merge-task 复用)
- `commands/plan-batch.cjs` — 候选 + scopeMutex 输出(JSON),内联互斥规则
- `commands/claim-batch.cjs` — 原子批量 claim + 写 currentTaskIds heartbeat
- `commands/worktree-create.cjs` / `commands/worktree-list.cjs` / `commands/worktree-discard.cjs`
- `commands/done-in-worktree.cjs` — code worker 在 worktree 内 WIP commit,deps 文件保护
- `commands/merge-task.cjs` — 主 loop 串行 merge(ff → rebase → 冲突转 review)
- `commands/requeue.cjs` — needs-code 回流:IN_PROGRESS → TODO + note 标记
- 测试:`tests/lib.worktree.test.cjs`、`tests/config.parallel.test.cjs`、`tests/lib.heartbeat-ids.test.cjs`、`tests/commands.plan-batch.test.cjs`、`tests/commands.claim-batch.test.cjs`、`tests/commands.done-in-worktree.test.cjs`、`tests/commands.merge-task.test.cjs`、`tests/commands.requeue.test.cjs`、`tests/commands.worktree-mgmt.test.cjs`、`tests/commands.next-limit.test.cjs`、`tests/commands.done-expect-clean.test.cjs`、`tests/integration.parallel-happy.test.cjs`、`tests/integration.parallel-faults.test.cjs`

### 修改
- `lib/config.cjs` — `parallel: {enabled, maxConcurrency, allowSameScope}` 默认值合并
- `lib/heartbeat.cjs` — `currentTaskIds[]` 双写(保留 `currentTaskId` 兼容 dashboard/watchdog 读)
- `commands/next.cjs` — `--limit N`(默认 1 兼容)
- `commands/done.cjs` — 抽核心到 done-core + 加 `--expect-clean`
- `commands/recover.cjs` — 扫 worktree orphan 按矩阵处理
- `tasks.cjs` — 注册 8 个新命令
- `templates/project.config.js` — 推荐并行配置块
- `loop-prompt.md` — 并行分支 + code/non-code worker 模板
- `commands/dashboard-server.cjs` + `web/` — 暴露 currentTaskIds
- `tests/_helpers.cjs` — `createTmpGitProjectFactory`
- `SKILL.md` — 新命令速查 + 并行说明

### 测试通用 fixture 约定

多个任务的测试都用这个 config 写入函数,**每个新测试文件都内联一份**(测试文件自包含,不进 _helpers):

```javascript
function writeParallelCfg(proj, parallel = { enabled: true, maxConcurrency: 3, allowSameScope: true }) {
  const fs = require('node:fs');
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true }, service: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true', service: 'true' },
      versionFiles: { web: 'package.json', service: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md', service: 'CHANGELOG.md' },
      inferModule: (_, s) => s,
      commitMessage: ({ scope, desc, version }) => scope + ': ' + desc + ' v' + version,
      parallel: ${JSON.stringify(parallel)},
    };
  `);
}
```

---

## Task 1: tests/_helpers 加 git 项目工厂

**Files:**
- Modify: `tests/_helpers.cjs`

- [ ] **Step 1:** 在 `tests/_helpers.cjs` 的 `captureStdout` 函数之后、`module.exports` 之前追加:

```javascript
const { execFileSync } = require('node:child_process');

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
```

导出行改为:

```javascript
module.exports = { createTmpProjectFactory, createTmpGitProjectFactory, captureStdout };
```

- [ ] **Step 2:** 跑全套确认未破坏:`cd ~/.claude/skills/task-queue && npm test` → 全 PASS。

- [ ] **Step 3:** Commit:

```bash
cd ~/.claude/skills/task-queue
git add tests/_helpers.cjs
git commit -m "test: 加 createTmpGitProjectFactory 供 worktree/merge 测试用"
```

---

## Task 2: lib/config 解析 parallel 字段

**Files:**
- Modify: `lib/config.cjs`
- Create: `tests/config.parallel.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/config.parallel.test.cjs`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadProjectConfig } = require('../lib/config.cjs');

function mkCfgDir(parallelLiteral) {
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
      ${parallelLiteral}
    };
  `);
  return dir;
}

test('parallel 字段缺失时返回默认 disabled(存量项目兼容)', () => {
  const cfg = loadProjectConfig(mkCfgDir(''));
  assert.deepEqual(cfg.parallel, { enabled: false, maxConcurrency: 3, allowSameScope: false });
});

test('parallel 字段存在时缺省项合并默认值', () => {
  const cfg = loadProjectConfig(mkCfgDir('parallel: { enabled: true, maxConcurrency: 5 },'));
  assert.equal(cfg.parallel.enabled, true);
  assert.equal(cfg.parallel.maxConcurrency, 5);
  assert.equal(cfg.parallel.allowSameScope, false);
});
```

- [ ] **Step 2:** `node --test tests/config.parallel.test.cjs` → FAIL(cfg.parallel undefined)。

- [ ] **Step 3: 实现** — `lib/config.cjs` 的 `loadProjectConfig` 中,`for (const field of REQUIRED_FIELDS)` 校验循环之后、`return cfg;` 之前插入:

```javascript
  // 并行执行配置:缺失字段按关闭兜底,存量项目行为与串行版完全一致
  cfg.parallel = {
    enabled: false,
    maxConcurrency: 3,
    allowSameScope: false,
    ...(cfg.parallel || {}),
  };
```

- [ ] **Step 4:** `node --test tests/config.parallel.test.cjs` → PASS;`npm test` → 全 PASS。

- [ ] **Step 5:** Commit:

```bash
git add lib/config.cjs tests/config.parallel.test.cjs
git commit -m "config: parallel.{enabled,maxConcurrency,allowSameScope} 默认值合并"
```

---

## Task 3: heartbeat 升级 currentTaskIds[](双写兼容)

**Files:**
- Modify: `lib/heartbeat.cjs`
- Create: `tests/lib.heartbeat-ids.test.cjs`

设计:**双写** —— 文件里同时维护 `currentTaskIds`(数组,新)与 `currentTaskId`(= ids[0] ?? null,旧镜像),dashboard-server / watchdog 现有读 `currentTaskId` 的代码零改动不坏。patch 语义:patch 里显式给了 `currentTaskIds` 用之;只给了 `currentTaskId`(现有 claim/done/next 调用方)→ 单值转数组(null → 空数组,即"清空");都没给 → 继承 prev。

- [ ] **Step 1: 写失败测试** — 新建 `tests/lib.heartbeat-ids.test.cjs`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeHeartbeat, readHeartbeat } = require('../lib/heartbeat.cjs');

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ids-'));
  fs.mkdirSync(path.join(dir, '.tasks', 'run'), { recursive: true });
  return dir;
}

test('写 currentTaskIds 数组 → 读回数组,且 currentTaskId 镜像为首元素', () => {
  const dir = mkRoot();
  writeHeartbeat(dir, { phase: 'executing', currentTaskIds: [7, 9] });
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, [7, 9]);
  assert.equal(hb.currentTaskId, 7);
});

test('旧调用方写单 currentTaskId → currentTaskIds 自动成 [id]', () => {
  const dir = mkRoot();
  writeHeartbeat(dir, { phase: 'executing', currentTaskId: 11 });
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, [11]);
  assert.equal(hb.currentTaskId, 11);
});

test('patch.currentTaskId=null 清空数组(done/next 的清场语义)', () => {
  const dir = mkRoot();
  writeHeartbeat(dir, { phase: 'executing', currentTaskIds: [7, 9] });
  writeHeartbeat(dir, { phase: 'idle', currentTaskId: null });
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, []);
  assert.equal(hb.currentTaskId, null);
});

test('patch 不含任务字段 → 继承 prev 数组', () => {
  const dir = mkRoot();
  writeHeartbeat(dir, { phase: 'executing', currentTaskIds: [7, 9] });
  writeHeartbeat(dir, { phase: 'executing' });
  assert.deepEqual(readHeartbeat(dir).currentTaskIds, [7, 9]);
});

test('readHeartbeat 读旧 schema 文件(只有 currentTaskId)→ 升级为数组', () => {
  const dir = mkRoot();
  fs.writeFileSync(path.join(dir, '.tasks', 'run', 'heartbeat.json'), JSON.stringify({
    phase: 'executing', currentTaskId: 5, model: 'x', ts: '2026-01-01T00:00:00Z',
  }));
  assert.deepEqual(readHeartbeat(dir).currentTaskIds, [5]);
});
```

- [ ] **Step 2:** `node --test tests/lib.heartbeat-ids.test.cjs` → FAIL。

- [ ] **Step 3: 实现** — 整文件替换 `lib/heartbeat.cjs`(保留现有 mkdir/模型 fallback 行为,只加 ids 归一):

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function heartbeatPath(projectRoot) {
  return path.join(projectRoot, '.tasks', 'run', 'heartbeat.json');
}

/**
 * 决定本次写入的任务 id 数组。优先级:
 * patch.currentTaskIds(显式数组)> patch.currentTaskId(单值,null=清空)> prev 继承。
 */
function resolveIds(patch, prev) {
  if (Array.isArray(patch.currentTaskIds)) return patch.currentTaskIds.filter(v => v != null);
  if (Object.prototype.hasOwnProperty.call(patch, 'currentTaskId')) {
    return patch.currentTaskId == null ? [] : [patch.currentTaskId];
  }
  if (Array.isArray(prev.currentTaskIds)) return prev.currentTaskIds.filter(v => v != null);
  if (prev.currentTaskId != null) return [prev.currentTaskId];
  return [];
}

function readHeartbeat(projectRoot) {
  const p = heartbeatPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw.currentTaskIds)) {
      raw.currentTaskIds = raw.currentTaskId != null ? [raw.currentTaskId] : [];
    }
    return raw;
  } catch (_) {
    return null;
  }
}

function writeHeartbeat(projectRoot, patch) {
  const p = heartbeatPath(projectRoot);
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const prev = readHeartbeat(projectRoot) || {};
    const ids = resolveIds(patch, prev);
    const next = {
      ...prev,
      ...patch,
      ts: new Date().toISOString(),
      model: patch.model || process.env.CLAUDE_MODEL || prev.model || 'unknown',
      // 双写:新数组 + 旧单值镜像(dashboard/watchdog 读旧字段零改动)
      currentTaskIds: ids,
      currentTaskId: ids.length ? ids[0] : null,
    };
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { writeHeartbeat, readHeartbeat, heartbeatPath };
```

- [ ] **Step 4:** `node --test tests/lib.heartbeat-ids.test.cjs` → PASS;`npm test` → 全 PASS(现有 heartbeat/claim/done 测试若有断言文件里无 `currentTaskIds` 字段需同步放宽,但**断言 `currentTaskId` 值的现有测试应原样通过**)。

- [ ] **Step 5:** Commit:

```bash
git add lib/heartbeat.cjs tests/lib.heartbeat-ids.test.cjs
git commit -m "heartbeat: currentTaskIds 数组 + currentTaskId 镜像双写,旧读方零改动"
```

---

## Task 4: lib/worktree — createForTask

**Files:**
- Create: `lib/worktree.cjs`
- Create: `tests/lib.worktree.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/lib.worktree.test.cjs`:

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
  const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }).toString().trim();
  assert.equal(head, 'task-7');
});

test('createForTask 从主仓库当前 HEAD 分支拉(不硬编码 main)', async () => {
  const proj = await setupProject([]);
  execFileSync('git', ['checkout', '-q', '-b', 'develop'], { cwd: proj });
  const { worktreePath } = createForTask(proj, 8);
  // worktree HEAD 与 develop HEAD 同 sha
  const wtSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath }).toString().trim();
  const devSha = execFileSync('git', ['rev-parse', 'develop'], { cwd: proj }).toString().trim();
  assert.equal(wtSha, devSha);
});

test('createForTask 给 worktree 建 node_modules symlink 指向主仓库', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 11);
  const nm = path.join(worktreePath, 'node_modules');
  assert.ok(fs.lstatSync(nm).isSymbolicLink(), 'node_modules 应为 symlink');
  assert.ok(fs.readlinkSync(nm).endsWith('node_modules'));
});

test('createForTask 重复同 id 抛错', async () => {
  const proj = await setupProject([]);
  createForTask(proj, 3);
  assert.throws(() => createForTask(proj, 3), /已存在|exists/i);
});
```

- [ ] **Step 2:** `node --test tests/lib.worktree.test.cjs` → FAIL("Cannot find module")。

- [ ] **Step 3: 实现** — 新建 `lib/worktree.cjs`:

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
 * 主仓库当前 HEAD 分支名(并行的 base 分支,不硬编码 main)。
 */
function defaultBranch(projectRoot) {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

/**
 * 创建任务专属 worktree,从 base 分支拉 task-N 分支,node_modules symlink 共享主仓库。
 * @param {string} projectRoot
 * @param {number|string} taskId
 * @param {string} [baseBranch] 缺省 = 主仓库当前 HEAD 分支
 * @returns {{worktreePath:string, branch:string, baseBranch:string}}
 */
function createForTask(projectRoot, taskId, baseBranch) {
  const base = baseBranch || defaultBranch(projectRoot);
  const wtPath = worktreePathFor(projectRoot, taskId);
  const branch = branchFor(taskId);
  if (fs.existsSync(wtPath)) {
    throw new Error(`worktree 已存在: ${wtPath}`);
  }
  fs.mkdirSync(worktreeRoot(projectRoot), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, wtPath, base], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srcNm = path.join(projectRoot, 'node_modules');
  if (fs.existsSync(srcNm)) {
    const dstNm = path.join(wtPath, 'node_modules');
    if (fs.existsSync(dstNm)) fs.rmSync(dstNm, { recursive: true, force: true });
    fs.symlinkSync(path.relative(wtPath, srcNm), dstNm, 'dir');
  }
  return { worktreePath: wtPath, branch, baseBranch: base };
}

module.exports = { createForTask, worktreePathFor, branchFor, worktreeRoot, defaultBranch };
```

- [ ] **Step 4:** `node --test tests/lib.worktree.test.cjs` → PASS。

- [ ] **Step 5:** Commit:

```bash
git add lib/worktree.cjs tests/lib.worktree.test.cjs
git commit -m "worktree: createForTask(HEAD 分支为 base)+ symlink node_modules"
```

---

## Task 5: lib/worktree — destroyForTask + listOrphans

**Files:**
- Modify: `lib/worktree.cjs`
- Modify: `tests/lib.worktree.test.cjs`

- [ ] **Step 1: 追加失败测试** — `tests/lib.worktree.test.cjs` 末尾追加(文件顶部 require 行改为同时引入 `destroyForTask, listOrphans`):

```javascript
const { destroyForTask, listOrphans } = require('../lib/worktree.cjs');

test('destroyForTask 删 worktree,默认保留分支;deleteBranch=true 删分支', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 21);
  destroyForTask(proj, 21);
  assert.ok(!fs.existsSync(worktreePath));
  let branches = execFileSync('git', ['branch'], { cwd: proj }).toString();
  assert.ok(branches.includes('task-21'), '默认应保留分支');
  createForTask(proj, 22);
  destroyForTask(proj, 22, { deleteBranch: true });
  branches = execFileSync('git', ['branch'], { cwd: proj }).toString();
  assert.ok(!branches.includes('task-22'), 'deleteBranch 应删分支');
});

test('destroyForTask force=true 删带未提交改动的 worktree;目标不存在时幂等不抛', async () => {
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 23);
  fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'unstaged');
  destroyForTask(proj, 23, { force: true });
  assert.ok(!fs.existsSync(worktreePath));
  destroyForTask(proj, 999);  // 不抛
});

test('listOrphans 列出 task-N worktree + 分支是否已 merge 回 base', async () => {
  const proj = await setupProject([]);
  createForTask(proj, 100);
  const { worktreePath } = createForTask(proj, 101);
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-q', '-m', 'wip'], { cwd: worktreePath });
  execFileSync('git', ['merge', '--ff-only', 'task-101'], { cwd: proj });
  const byId = Object.fromEntries(listOrphans(proj).map(o => [o.taskId, o]));
  assert.equal(byId[100].branchMerged, true);   // 无新 commit,task-100 == base → merged
  assert.equal(byId[101].branchMerged, true);
});

test('listOrphans 未 merge 的分支 branchMerged=false;无 worktree 时空数组', async () => {
  const proj = await setupProject([]);
  assert.deepEqual(listOrphans(proj), []);
  const { worktreePath } = createForTask(proj, 102);
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'y');
  execFileSync('git', ['add', '.'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-q', '-m', 'wip'], { cwd: worktreePath });
  // 不 merge
  const byId = Object.fromEntries(listOrphans(proj).map(o => [o.taskId, o]));
  assert.equal(byId[102].branchMerged, false);
});
```

- [ ] **Step 2:** `node --test tests/lib.worktree.test.cjs` → 新测试 FAIL。

- [ ] **Step 3: 实现** — `lib/worktree.cjs` 末尾追加两个函数,并更新导出行:

```javascript
/**
 * 删除任务 worktree,可选删分支。幂等(目标不存在不抛)。
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
    } catch (_) {
      fs.rmSync(wtPath, { recursive: true, force: true });
      try { execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot }); } catch (_) {}
    }
  }
  if (opts.deleteBranch) {
    try {
      execFileSync('git', ['branch', '-D', branch], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) { /* 分支不存在,忽略 */ }
  }
}

/**
 * 列出 .tasks/worktrees 下所有 task-N 目录及分支 merge 状态。
 * @returns {Array<{taskId:number, worktreePath:string, branch:string, branchMerged:boolean}>}
 */
function listOrphans(projectRoot, baseBranch) {
  const root = worktreeRoot(projectRoot);
  if (!fs.existsSync(root)) return [];
  const base = baseBranch || defaultBranch(projectRoot);
  const entries = fs.readdirSync(root)
    .map(name => {
      const m = name.match(/^task-(\d+)$/);
      return m ? { name, taskId: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean);
  let mergedBranches = new Set();
  try {
    const out = execFileSync('git', ['branch', '--merged', base], {
      cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    mergedBranches = new Set(out.split('\n').map(s => s.replace(/^[*+]?\s*/, '').trim()).filter(Boolean));
  } catch (_) {}
  return entries.map(e => ({
    taskId: e.taskId,
    worktreePath: path.join(root, e.name),
    branch: branchFor(e.taskId),
    branchMerged: mergedBranches.has(branchFor(e.taskId)),
  }));
}

module.exports = {
  createForTask, destroyForTask, listOrphans,
  worktreePathFor, branchFor, worktreeRoot, defaultBranch,
};
```

注意:`git branch --merged` 输出里 checked-out 于 worktree 的分支前缀是 `+`,正则要同时剥 `*` 和 `+`(上面已处理)。

- [ ] **Step 4:** `node --test tests/lib.worktree.test.cjs` → PASS。

- [ ] **Step 5:** Commit:

```bash
git add lib/worktree.cjs tests/lib.worktree.test.cjs
git commit -m "worktree: destroyForTask 幂等删除 + listOrphans 分支 merge 状态"
```

---

## Task 6: commands/plan-batch

**Files:**
- Create: `commands/plan-batch.cjs`
- Create: `tests/commands.plan-batch.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.plan-batch.test.cjs`:

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const planBatchCmd = require('../commands/plan-batch.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('plan-batch-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeParallelCfg(proj, parallel = { enabled: true, maxConcurrency: 3, allowSameScope: true }) {
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true }, service: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true', service: 'true' },
      versionFiles: { web: 'package.json', service: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md', service: 'CHANGELOG.md' },
      inferModule: (_, s) => s,
      commitMessage: ({ scope, desc, version }) => scope + ': ' + desc + ' v' + version,
      parallel: ${JSON.stringify(parallel)},
    };
  `);
}

const ROWS = [
  { id: 7, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', model: 'sonnet', ctime: '2026-01-01T00:00:00Z' },
  { id: 8, desc: 'b', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
  { id: 9, desc: 'c', scope: 'service', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:02:00Z' },
];

test('plan-batch 默认 limit=5,输出候选(含 model) + scopeMutex + 配置', async () => {
  const proj = await setupProject(ROWS);
  writeParallelCfg(proj);
  const j = JSON.parse(await captureStdout(() => planBatchCmd(proj, [])));
  assert.equal(j.candidates.length, 3);
  assert.equal(j.candidates[0].model, 'sonnet');
  assert.ok(j.scopeMutex.some(p => p.includes(7) && p.includes(8)));
  assert.ok(!j.scopeMutex.some(p => p.includes(7) && p.includes(9)));
  assert.equal(j.maxConcurrency, 3);
  assert.equal(j.allowSameScope, true);
});

test('plan-batch --limit 2 截断,按优先级+ctime 排序', async () => {
  const proj = await setupProject(ROWS);
  writeParallelCfg(proj);
  const j = JSON.parse(await captureStdout(() => planBatchCmd(proj, ['--limit', '2'])));
  assert.deepEqual(j.candidates.map(c => c.id), [7, 8]);
});

test('parallel.enabled=false 时返回空 + reason 提示走串行', async () => {
  const proj = await setupProject(ROWS);
  writeParallelCfg(proj, { enabled: false });
  const j = JSON.parse(await captureStdout(() => planBatchCmd(proj, [])));
  assert.deepEqual(j.candidates, []);
  assert.match(j.reason || '', /未启用|串行/);
});
```

- [ ] **Step 2:** `node --test tests/commands.plan-batch.test.cjs` → FAIL。

- [ ] **Step 3: 实现** — 新建 `commands/plan-batch.cjs`:

```javascript
'use strict';

const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { sortByPriorityAndCtime } = require('../lib/sort.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');

/**
 * 并行 Step 1.5:输出候选 + scope 互斥提示,供主 Claude 标 lane / 挑批次。
 * 规则计算只有 scopeMutex(同 scope 两两配对);语义判断(lane / desc 是否独立)由主 Claude 做。
 * @param {string} projectRoot
 * @param {string[]} args 支持 --limit N(默认 5)
 */
module.exports = async function planBatch(projectRoot, args) {
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg.parallel.enabled) {
    process.stdout.write(JSON.stringify({
      candidates: [], scopeMutex: [],
      reason: 'parallel 未启用,走串行 next/claim 路径',
    }) + '\n');
    return;
  }

  let limit = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') { limit = parseInt(args[i + 1], 10) || limit; i++; }
  }

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const todos = rows.filter(r => r.status === STATES.TODO);
  sortByPriorityAndCtime(todos);
  const candidates = todos.slice(0, limit).map(r => ({
    id: r.id, desc: r.desc, scope: r.scope, priority: r.priority,
    note: r.note, model: r.model || '',
  }));

  const scopeMutex = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[i].scope === candidates[j].scope) {
        scopeMutex.push([candidates[i].id, candidates[j].id]);
      }
    }
  }

  process.stdout.write(JSON.stringify({
    candidates, scopeMutex,
    maxConcurrency: cfg.parallel.maxConcurrency,
    allowSameScope: cfg.parallel.allowSameScope,
  }) + '\n');
};
```

- [ ] **Step 4:** `node --test tests/commands.plan-batch.test.cjs` → PASS。

- [ ] **Step 5:** Commit:

```bash
git add commands/plan-batch.cjs tests/commands.plan-batch.test.cjs
git commit -m "plan-batch: 输出候选 + scopeMutex 供主 Claude 编排"
```

---

## Task 7: commands/claim-batch(原子批量 claim)

**Files:**
- Create: `commands/claim-batch.cjs`
- Create: `tests/commands.claim-batch.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.claim-batch.test.cjs`:

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

test('claim-batch 把多条 id 同步标进行中,输出 claimed 列表', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'b', scope: 'svc', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  const j = JSON.parse(await captureStdout(() => claimBatchCmd(proj, ['1', '2'])));
  assert.equal(j.claimed.length, 2);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 1).status, '进行中');
  assert.equal(rows.find(r => r.id === 2).status, '进行中');
});

test('claim-batch 某条非待办 → 抛错且整批不落盘', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'b', scope: 'svc', priority: '高', status: '已完成-待review', note: '', risk: 'x', ctime: '' },
  ]);
  await assert.rejects(() => claimBatchCmd(proj, ['1', '2']), /非法转换/);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => r.id === 1).status, '待办');
});

test('claim-batch 写 heartbeat currentTaskIds + 聚合 desc', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'aaa', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 'bbb', scope: 'svc', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  await captureStdout(() => claimBatchCmd(proj, ['1', '2']));
  const hb = JSON.parse(fs.readFileSync(path.join(proj, '.tasks', 'run', 'heartbeat.json'), 'utf8'));
  assert.deepEqual([...hb.currentTaskIds].sort(), [1, 2]);
  assert.equal(hb.phase, 'executing');
  assert.match(hb.currentTaskDesc, /#1.*aaa/);
  assert.match(hb.currentTaskDesc, /#2.*bbb/);
});
```

- [ ] **Step 2:** `node --test tests/commands.claim-batch.test.cjs` → FAIL。

- [ ] **Step 3: 实现** — 新建 `commands/claim-batch.cjs`:

```javascript
'use strict';

const path = require('node:path');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex } = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');

/**
 * 原子批量 claim:校验全部合法后才进 withWorkbook 一次写入;任何一条非法 → 抛错,Excel 不动。
 * @param {string} projectRoot
 * @param {string[]} args id 列表
 */
module.exports = async function claimBatch(projectRoot, args) {
  if (!args || args.length === 0) throw new Error('claim-batch 需要至少 1 个 id');
  const ids = args.map(String);

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
    currentTaskDesc: targets.map(t => `#${t.id} ${t.desc}`).join(' ｜ '),
  });

  process.stdout.write(JSON.stringify({
    claimed: targets.map(t => ({
      id: t.id, desc: t.desc, scope: t.scope, note: t.note,
      model: t.model || '', checklist: t.checklist || '',
    })),
  }) + '\n');
};
```

- [ ] **Step 4:** `node --test tests/commands.claim-batch.test.cjs` → PASS。

- [ ] **Step 5:** Commit:

```bash
git add commands/claim-batch.cjs tests/commands.claim-batch.test.cjs
git commit -m "claim-batch: 原子批量 claim + currentTaskIds/聚合 desc heartbeat"
```

---

## Task 8: 抽取 lib/done-core(零行为变更重构)

**Files:**
- Create: `lib/done-core.cjs`
- Modify: `commands/done.cjs`

**这是全计划最精细的一步。** 从**当前** `commands/done.cjs`(345 行,带 summary 强制/checklist 护栏/`.tasks/` 过滤/changelog 可选)抽出可被 merge-task 复用的核心。现有全部 done 测试必须原样通过。

- [ ] **Step 1: 先确认谁在 import done.cjs 的导出**

```bash
cd ~/.claude/skills/task-queue && grep -rn "require.*done.cjs" commands/ lib/ tests/ | grep -v done.test
```

凡是用 `done.cjs` 的 `buildDoneBlock`/`prependDoneBlock` 的(如 reply/mark-done/reopen),保持 `done.cjs` 末尾的 re-export 不动即可,无需改它们。

- [ ] **Step 2: 新建 `lib/done-core.cjs`** — 下列函数**从 done.cjs 原样搬移**(保留注释):`buildDoneBlock`、`prependDoneBlock`、`bumpPatchDefault`、`moveRowToArchive`、`transitionToReview`;再把 done.cjs `try {...}` 主体抽成 `commitAndArchive`。完整文件:

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED, colIndex,
} = require('./workbook.cjs');
const { STATES } = require('./states.cjs');
const { gitStatus, gitAdd, gitCommit, gitRevParseHead, gitLogToday } = require('./git.cjs');
const { writeHeartbeat, readHeartbeat } = require('./heartbeat.cjs');
const { localTimestamp } = require('./datetime.cjs');

// ⬇⬇ buildDoneBlock / prependDoneBlock / bumpPatchDefault / moveRowToArchive
//    四个函数连同 JSDoc 从 commands/done.cjs 原样搬来,此处不重复罗列 —— 执行时
//    直接剪切 done.cjs 的 21-67 行(以当前文件为准)粘到这里,函数体一字不改。

/**
 * 任务收尾时的 heartbeat:把 taskId 从 currentTaskIds 摘除,剩余非空保持 executing
 * (并行 merge 中场),清空则 idle。串行路径下等价于旧的 {phase:'idle',currentTaskId:null}。
 */
function releaseTask(projectRoot, taskId, { finishedAt } = {}) {
  const prev = readHeartbeat(projectRoot) || {};
  const remaining = (prev.currentTaskIds || []).filter(x => String(x) !== String(taskId));
  writeHeartbeat(projectRoot, {
    phase: remaining.length ? 'executing' : 'idle',
    currentTaskIds: remaining,
    lastFinishedId: taskId,
    lastFinishedAt: finishedAt || new Date().toISOString(),
  });
}

// transitionToReview 从 done.cjs 原样搬来,唯一改动:函数末尾的 writeHeartbeat({...}) 调用
// 整段替换为 releaseTask(projectRoot, taskId)。JSDoc 保留。

/**
 * commit + 归档核心(原 done.cjs try 块主体)。调用前提:target 已校验为 IN_PROGRESS、
 * scope 存在且 autoCommit=true、summary 非空。
 * 主仓库工作区当前的改动 = 本任务的改动(串行 done 直接如此;merge-task 在 ff+reset 后如此)。
 * @returns {Promise<{ok:true, commitHash:string|null, version:string|null, moduleName:string|null}
 *                  |{review:true, risk:string}>}
 */
async function commitAndArchive({ projectRoot, xlsxPath, target, cfg, scopeName, summary, logger }) {
  try {
    // ⬇ 以下整段从 done.cjs 当前 218-332 行(try 块内部)原样搬移,只做 4 处机械替换:
    //   1. 所有 `return;` → 按所处分支改为 `return { ok:true, ... }` 或 `return { review:true, risk:<同 risk 文案> };`
    //   2. 无改动归档分支末尾的 writeHeartbeat({phase:'idle',currentTaskId:null,...}) → releaseTask(projectRoot, target.id, { finishedAt: target.ftime })
    //   3. 成功路径末尾的 writeHeartbeat 同上替换
    //   4. transitionToReview 调用保持(它已在本文件内)
    // 搬移后本函数返回值:
    //   无文件改动归档 → { ok: true, commitHash: null, version: null, moduleName: null }
    //   inferModule 失败 / versionFiles 缺配置 → transitionToReview(... {summary, oldNote: target.note}) 后 { review: true, risk: <同文案> }
    //   commit 成功 → { ok: true, commitHash, version, moduleName }
  } catch (e) {
    const msg = (e.message || '').slice(0, 200);
    await transitionToReview(xlsxPath, target._rowNumber, `commit 阶段失败：${msg}`,
      logger, projectRoot, target.id, { summary, oldNote: target.note });
    return { review: true, risk: msg };
  }
}

module.exports = {
  buildDoneBlock, prependDoneBlock, bumpPatchDefault,
  moveRowToArchive, transitionToReview, releaseTask, commitAndArchive,
};
```

(上面两处 "原样搬移" 注释是给执行者的指令,落盘文件里写真实代码、删掉指令注释。)

- [ ] **Step 3: 改写 `commands/done.cjs`** — 删除被搬走的函数,改为从 done-core import;主体保留:参数解析、target 查找/状态校验、checklist 护栏(`revertToTodoForIncompleteChecklist` 留在 done.cjs,不动)、summary 强制、scope 两道闸,然后:

```javascript
  const result = await commitAndArchive({
    projectRoot, xlsxPath, target, cfg, scopeName, summary, logger,
  });
  if (result.ok && result.commitHash) {
    logger.info(`task #${target.id} done + commit ${result.commitHash} 【${result.moduleName}】 ${result.version}`);
  } else if (result.ok) {
    logger.info(`task #${target.id} done (无文件改动，已归档)`);
  }
```

文件末尾 re-export 保持(改为转发 done-core):

```javascript
module.exports.buildDoneBlock = buildDoneBlock;
module.exports.prependDoneBlock = prependDoneBlock;
```

注意:logger.info 的两条成功日志**移到 done.cjs 这里**(commitAndArchive 内部不再打,避免 merge-task 复用时双份日志措辞)——若搬移时发现 info 日志在 try 块里,删掉那两行换成上面的写法。

- [ ] **Step 4:** `npm test` → **全 PASS,零行为变更**。重点盯 done 相关测试文件。若现有测试断言 heartbeat 文件含 `currentTaskId: null`,releaseTask 双写后该断言仍然成立(Task 3 保证)。

- [ ] **Step 5:** Commit:

```bash
git add lib/done-core.cjs commands/done.cjs
git commit -m "refactor: 抽 commitAndArchive/transitionToReview 到 lib/done-core,done.cjs 复用"
```

---

## Task 9: done --expect-clean(non-code lane 脏检查)

**Files:**
- Modify: `commands/done.cjs`
- Create: `tests/commands.done-expect-clean.test.cjs`

non-code worker 声称不改文件;主 loop 用 `done <root> <id> "<summary>" --expect-clean` 归档。若仓库脏(`.tasks/` 外):还原 tracked 改动 + 转 review,绝不 commit。

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.done-expect-clean.test.cjs`:

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory } = require('./_helpers.cjs');
const doneCmd = require('../commands/done.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('done-clean-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeParallelCfg(proj) {
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

test('--expect-clean 且仓库干净 → 正常无 commit 归档', async () => {
  const proj = await setupProject([
    { id: 1, desc: '调研', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await doneCmd(proj, ['1', '调研结论:...', '--expect-clean']);
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(arch.length, 1);
  assert.equal(arch[0].status, '已完成');
});

test('--expect-clean 且 tracked 文件被改 → 还原 + 转 review,不 commit', async () => {
  const proj = await setupProject([
    { id: 2, desc: '调研', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  fs.writeFileSync(path.join(proj, 'README.md'), '# polluted\n');
  await doneCmd(proj, ['2', '结论', '--expect-clean']);
  // tracked 文件已还原
  assert.equal(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), '# test\n');
  // 无新 commit
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: proj }).toString().trim();
  assert.equal(count, '1');
  // 转 review,risk 写明
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.match(String(rows[0].risk), /non-code|不应改/);
});

test('--expect-clean 且有 untracked 新文件 → 不删文件但转 review 列出', async () => {
  const proj = await setupProject([
    { id: 3, desc: '调研', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  fs.writeFileSync(path.join(proj, 'leak.txt'), 'x');
  await doneCmd(proj, ['3', '结论', '--expect-clean']);
  assert.ok(fs.existsSync(path.join(proj, 'leak.txt')), 'untracked 不删,留给人看');
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.match(String(rows[0].risk), /leak\.txt/);
});
```

- [ ] **Step 2:** `node --test tests/commands.done-expect-clean.test.cjs` → FAIL。

- [ ] **Step 3: 实现** — `commands/done.cjs`:

参数解析处(`const summary = args[1];` 之后)加:

```javascript
  const expectClean = args.includes('--expect-clean');
```

scope 两道闸**之后**、`commitAndArchive` 调用**之前**插入:

```javascript
  // non-code lane 护栏:声称不改文件的任务,仓库必须干净;脏 → 还原 tracked + review,绝不 commit
  if (expectClean) {
    const dirty = gitStatus(projectRoot).filter(p => !p.startsWith('.tasks/'));
    if (dirty.length > 0) {
      const { execFileSync } = require('node:child_process');
      const restored = [];
      const untracked = [];
      for (const f of dirty) {
        try {
          // tracked 改动还原;untracked 文件 checkout 会报错 → 留着列给人看
          execFileSync('git', ['checkout', '--', f], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
          restored.push(f);
        } catch (_) {
          untracked.push(f);
        }
      }
      await transitionToReview(
        xlsxPath, target._rowNumber,
        `non-code 任务不应改仓库文件。已还原: ${restored.join(', ') || '无'};`
        + `未删的新增文件: ${untracked.join(', ') || '无'}。`
        + '若该任务确需改代码,请 reply 说明后重开为 code lane。',
        logger, projectRoot, target.id, { summary, oldNote: target.note },
      );
      return;
    }
  }
```

(`gitStatus` 与 `transitionToReview` 在 Task 8 后均已在 done.cjs 的 import 列表里;若 `gitStatus` 被移除了就补回 `require('../lib/git.cjs')`。)

- [ ] **Step 4:** `node --test tests/commands.done-expect-clean.test.cjs` → PASS;`npm test` → 全 PASS。

- [ ] **Step 5:** Commit:

```bash
git add commands/done.cjs tests/commands.done-expect-clean.test.cjs
git commit -m "done: --expect-clean 护栏(non-code 任务脏仓库 → 还原+review)"
```

---

## Task 10: commands/done-in-worktree

**Files:**
- Create: `commands/done-in-worktree.cjs`
- Create: `tests/commands.done-in-worktree.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.done-in-worktree.test.cjs`:

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

test('无改动 → ok:true commitSha:null,Excel 不动', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  createForTask(proj, 1);
  const j = JSON.parse(await captureStdout(() => doneInWorktreeCmd(proj, ['1'])));
  assert.equal(j.ok, true);
  assert.equal(j.commitSha, null);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '进行中', 'Excel 由主进程管,worker 命令不动');
});

test('有改动 → commit 到 task-N 分支,main 不受影响', async () => {
  const proj = await setupProject([
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  const { worktreePath } = createForTask(proj, 2);
  fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello');
  const j = JSON.parse(await captureStdout(() => doneInWorktreeCmd(proj, ['2'])));
  assert.equal(j.ok, true);
  assert.match(j.commitSha, /^[0-9a-f]{7,40}$/);
  const mainCount = execFileSync('git', ['rev-list', '--count', 'main'], { cwd: proj }).toString().trim();
  assert.equal(mainCount, '1', 'main 只有 init commit');
});

test('改了 package.json → 拒绝 commit,ok:false', async () => {
  const proj = await setupProject([
    { id: 3, desc: 'c', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  const { worktreePath } = createForTask(proj, 3);
  fs.writeFileSync(path.join(worktreePath, 'package.json'),
    JSON.stringify({ name: 'test', version: '0.0.2' }, null, 2) + '\n');
  const j = JSON.parse(await captureStdout(() => doneInWorktreeCmd(proj, ['3'])));
  assert.equal(j.ok, false);
  assert.match(j.reason, /依赖|package\.json/);
});

test('worktree 不存在 → 抛错', async () => {
  const proj = await setupProject([
    { id: 4, desc: 'd', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  await assert.rejects(() => doneInWorktreeCmd(proj, ['4']), /worktree.*不存在/);
});
```

- [ ] **Step 2:** `node --test tests/commands.done-in-worktree.test.cjs` → FAIL。

- [ ] **Step 3: 实现** — 新建 `commands/done-in-worktree.cjs`:

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { worktreePathFor } = require('../lib/worktree.cjs');

const DEPS_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pom.xml'];

function changedFilesIn(wtPath) {
  const out = execFileSync('git', ['status', '--porcelain=v1'], { cwd: wtPath }).toString();
  return out.split('\n').filter(Boolean).map(line => {
    const filePath = line.slice(3).trim();
    const arrowIdx = filePath.indexOf(' -> ');
    return arrowIdx === -1 ? filePath : filePath.slice(arrowIdx + 4);
  });
}

/**
 * code worker 在 worktree 内调:把改动 WIP commit 到自己的 task-N 分支。
 * 不动 Excel、不动主仓库;改了依赖文件直接拒绝(并行模式禁 deps 变更,spec 已知限制 2)。
 * @param {string} projectRoot
 * @param {string[]} args args[0] = taskId
 */
module.exports = async function doneInWorktree(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('done-in-worktree 需要 id 参数');
  const wtPath = worktreePathFor(projectRoot, idArg);
  if (!fs.existsSync(wtPath)) throw new Error(`worktree 不存在:${wtPath}`);

  const changed = changedFilesIn(wtPath);
  if (changed.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, taskId: idArg, commitSha: null, changedFiles: [] }) + '\n');
    return;
  }

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
  process.stdout.write(JSON.stringify({ ok: true, taskId: idArg, commitSha: sha, changedFiles: changed }) + '\n');
};
```

- [ ] **Step 4:** `node --test tests/commands.done-in-worktree.test.cjs` → PASS。

- [ ] **Step 5:** Commit:

```bash
git add commands/done-in-worktree.cjs tests/commands.done-in-worktree.test.cjs
git commit -m "done-in-worktree: worker WIP commit 到 task 分支 + deps 文件保护"
```

---

## Task 11: commands/merge-task

**Files:**
- Create: `commands/merge-task.cjs`
- Create: `tests/commands.merge-task.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.merge-task.test.cjs`:

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

function writeParallelCfg(proj) {
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

async function setupReadyForMerge(id = 1) {
  const proj = await setupProject([{
    id, desc: 'feat', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '',
  }]);
  writeParallelCfg(proj);
  const { worktreePath } = createForTask(proj, id);
  fs.writeFileSync(path.join(worktreePath, 'feat.txt'), 'hello');
  await captureStdout(() => doneInWorktreeCmd(proj, [String(id)]));
  return { proj, worktreePath };
}

test('ff-merge 成功:main 有正式 commit(含版本号),worktree+分支清除,任务归档', async () => {
  const { proj, worktreePath } = await setupReadyForMerge();
  const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['1', '加了 feat.txt'])));
  assert.equal(j.ok, true);
  const log = execFileSync('git', ['log', '--oneline'], { cwd: proj }).toString();
  assert.match(log, /web: feat v0\.0\.2/);
  assert.ok(!log.includes('WIP task'), 'WIP commit 应被正式 commit 取代');
  assert.ok(!fs.existsSync(worktreePath));
  const branches = execFileSync('git', ['branch'], { cwd: proj }).toString();
  assert.ok(!branches.includes('task-1'));
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(arch[0].status, '已完成');
  assert.match(String(arch[0].note), /加了 feat\.txt/);
});

test('main 已前进但无冲突 → rebase 后 merge 成功', async () => {
  const { proj } = await setupReadyForMerge(2);
  // main 前进:改不相干文件
  fs.writeFileSync(path.join(proj, 'other.txt'), 'main moved');
  execFileSync('git', ['add', 'other.txt'], { cwd: proj });
  execFileSync('git', ['commit', '-q', '-m', 'main forward'], { cwd: proj });
  const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['2', 's'])));
  assert.equal(j.ok, true);
});

test('rebase 冲突 → 转 review,worktree 保留,summary 保全进 note', async () => {
  const { proj, worktreePath } = await setupReadyForMerge(3);
  fs.writeFileSync(path.join(proj, 'feat.txt'), 'MAIN VERSION');
  execFileSync('git', ['add', 'feat.txt'], { cwd: proj });
  execFileSync('git', ['commit', '-q', '-m', 'main override'], { cwd: proj });
  const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['3', '做完了但撞了'])));
  assert.equal(j.ok, false);
  assert.match(j.reason, /冲突/);
  assert.ok(fs.existsSync(worktreePath), 'worktree 保留给人工');
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.match(String(rows[0].risk), /worktrees\/task-3/);
  assert.match(String(rows[0].note), /做完了但撞了');
});

test('summary 缺失 → 转 review(与 done 同语义)', async () => {
  const { proj } = await setupReadyForMerge(4);
  const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['4'])));
  assert.equal(j.ok, false);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
});
```

(注意第 3 个测试里 `/做完了但撞了'/` 是笔误示范 —— 执行时写成 `/做完了但撞了/`。)

- [ ] **Step 2:** `node --test tests/commands.merge-task.test.cjs` → FAIL。

- [ ] **Step 3: 实现** — 新建 `commands/merge-task.cjs`:

```javascript
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { Logger } = require('../lib/logger.cjs');
const { transitionToReview, commitAndArchive, releaseTask } = require('../lib/done-core.cjs');
const { worktreePathFor, branchFor, destroyForTask, defaultBranch } = require('../lib/worktree.cjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function tryFfMerge(projectRoot, branch) {
  try { git(projectRoot, ['merge', '--ff-only', branch]); return true; } catch (_) { return false; }
}

function tryRebase(worktreePath, base) {
  try { git(worktreePath, ['rebase', base]); return true; } catch (_) {
    try { git(worktreePath, ['rebase', '--abort']); } catch (_) {}
    return false;
  }
}

/**
 * 主 loop 在 code worker 返回后串行调用:把 task-N 分支合回 base 分支。
 * ff → 失败则 rebase 后再 ff → 仍失败转 review 保留 worktree。
 * ff 成功后 reset 掉 WIP commit,复用 done-core 走版本号/changelog/正式 commit/归档。
 * @param {string} projectRoot
 * @param {string[]} args args[0]=taskId, args[1]=summary(worker 返回的成果描述,必传)
 */
module.exports = async function mergeTask(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('merge-task 需要 id 参数');
  const summary = args[1];
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const cfg = loadProjectConfig(projectRoot);
  const logger = new Logger(projectRoot);
  const branch = branchFor(idArg);
  const wtPath = worktreePathFor(projectRoot, idArg);
  const base = defaultBranch(projectRoot);

  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);
  if (target.status !== STATES.IN_PROGRESS) {
    throw new Error(`非法转换:#${idArg} ${target.status} → 已完成`);
  }

  if (!summary || !String(summary).trim()) {
    await transitionToReview(xlsxPath, target._rowNumber,
      'merge-task 未提供 summary(worker 返回正文应含 1-2 句成果描述)。请 reply 补答复后重试 merge-task。',
      logger, projectRoot, target.id);
    process.stdout.write(JSON.stringify({ ok: false, taskId: idArg, reason: 'summary 缺失,转 review' }) + '\n');
    return;
  }

  const scopeName = target.scope;
  const scopeCfg = cfg.scopes[scopeName];
  if (!scopeCfg || !scopeCfg.autoCommit) {
    await transitionToReview(xlsxPath, target._rowNumber,
      `scope ${scopeName} 不存在或不允许自动 commit,worktree 保留在 .tasks/worktrees/task-${idArg}`,
      logger, projectRoot, target.id, { summary, oldNote: target.note });
    process.stdout.write(JSON.stringify({ ok: false, taskId: idArg, reason: 'scope 禁用 autoCommit,转 review' }) + '\n');
    return;
  }

  // 分支领先 base 的 commit 数(正常 = 1 个 WIP;0 = worker 没改东西)
  const ahead = parseInt(git(projectRoot, ['rev-list', '--count', `${base}..${branch}`]).trim(), 10);

  if (ahead > 0) {
    let merged = tryFfMerge(projectRoot, branch);
    if (!merged && tryRebase(wtPath, base)) {
      merged = tryFfMerge(projectRoot, branch);
    }
    if (!merged) {
      await transitionToReview(xlsxPath, target._rowNumber,
        `merge 冲突。worktree 保留在 .tasks/worktrees/task-${idArg},人工解决后跑 merge-task ${idArg} 重试,`
        + `或 worktree-discard ${idArg} 放弃。`,
        logger, projectRoot, target.id, { summary, oldNote: target.note });
      process.stdout.write(JSON.stringify({ ok: false, taskId: idArg, reason: 'rebase 冲突,转 review 保留 worktree' }) + '\n');
      return;
    }
    // ff 后 base HEAD = task-N HEAD;退掉 WIP commit(可能因 rebase 重写,按 ahead 数退),
    // 改动落回工作区,交给 done-core 重做版本号 + changelog + 正式 commit
    git(projectRoot, ['reset', '--mixed', `HEAD~${ahead}`]);
  }
  // ahead === 0:无改动,工作区本来就干净,commitAndArchive 走"无文件改动归档"路径

  const result = await commitAndArchive({ projectRoot, xlsxPath, target, cfg, scopeName, summary, logger });

  if (result.review) {
    // done-core 已转 review(含 heartbeat);worktree 保留给人工
    process.stdout.write(JSON.stringify({ ok: false, taskId: idArg, reason: result.risk }) + '\n');
    return;
  }

  destroyForTask(projectRoot, idArg, { force: true, deleteBranch: true });
  logger.info(`task #${idArg} merge-task 完成 ${result.version || '(无 commit)'}`);
  process.stdout.write(JSON.stringify({
    ok: true, taskId: idArg, commitHash: result.commitHash, version: result.version, module: result.moduleName,
  }) + '\n');
};
```

- [ ] **Step 4:** `node --test tests/commands.merge-task.test.cjs` → PASS;`npm test` → 全 PASS。

- [ ] **Step 5:** Commit:

```bash
git add commands/merge-task.cjs tests/commands.merge-task.test.cjs
git commit -m "merge-task: ff/rebase 串行合并,冲突转 review 保留 worktree,复用 done-core"
```

---

## Task 12: commands/requeue(needs-code 回流)

**Files:**
- Create: `commands/requeue.cjs`
- Create: `tests/commands.requeue.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.requeue.test.cjs`:

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const requeueCmd = require('../commands/requeue.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('requeue-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('requeue 把进行中任务转回待办,note 顶部加 [needs-code] 标记', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '进行中', note: '旧备注', ctime: '' },
  ]);
  const j = JSON.parse(await captureStdout(() => requeueCmd(proj, ['1', '其实要改 LoginPage.tsx'])));
  assert.equal(j.ok, true);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '待办');
  assert.match(String(rows[0].note), /^\[needs-code .*\] 其实要改 LoginPage\.tsx/);
  assert.match(String(rows[0].note), /旧备注/);
});

test('requeue 非进行中任务 → 抛错', async () => {
  const proj = await setupProject([
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  await assert.rejects(() => requeueCmd(proj, ['2', 'x']), /非法转换/);
});

test('reason 以 -- 开头 → 拒绝(防 flag 误传)', async () => {
  const proj = await setupProject([
    { id: 3, desc: 'c', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  await assert.rejects(() => requeueCmd(proj, ['3', '--summary']), /flag|--/);
});
```

- [ ] **Step 2:** `node --test tests/commands.requeue.test.cjs` → FAIL。

- [ ] **Step 3: 实现** — 新建 `commands/requeue.cjs`:

```javascript
'use strict';

const path = require('node:path');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex } = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { writeHeartbeat, readHeartbeat } = require('../lib/heartbeat.cjs');
const { localTimestamp } = require('../lib/datetime.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * needs-code 回流:non-code worker 发现任务其实要改代码时,主 loop 调本命令把任务
 * IN_PROGRESS → TODO,note 顶部加 [needs-code] 标记;下一轮 plan-batch 看到标记强制走 code lane。
 * 回流只允许一次 —— note 已含 [needs-code 的任务由主 loop 改调 review(loop-prompt 负责判断)。
 * @param {string} projectRoot
 * @param {string[]} args args[0]=id, args[1]=原因
 */
module.exports = async function requeue(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('requeue 需要 id 参数');
  const reason = args[1] || '';
  if (reason.startsWith('--')) throw new Error('reason 不能以 -- 开头(疑似误传 flag)');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);
  if (!canTransition(target.status, STATES.TODO)) {
    throw new Error(`非法转换:#${idArg} ${target.status} → 待办`);
  }

  const tag = `[needs-code ${localTimestamp()}] ${reason}`.trim();
  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(target._rowNumber);
    row.getCell(colIndex('status')).value = STATES.TODO;
    const prevNote = target.note || '';
    row.getCell(colIndex('note')).value = prevNote ? `${tag}\n---\n${prevNote}` : tag;
    row.commit();
  });

  // 从 currentTaskIds 摘除(任务没结束,不写 lastFinishedId)
  const prev = readHeartbeat(projectRoot) || {};
  const remaining = (prev.currentTaskIds || []).filter(x => String(x) !== String(idArg));
  writeHeartbeat(projectRoot, {
    phase: remaining.length ? 'executing' : 'idle',
    currentTaskIds: remaining,
  });

  new Logger(projectRoot).warn(`task #${idArg} requeue(needs-code): ${reason}`);
  process.stdout.write(JSON.stringify({ ok: true, taskId: idArg }) + '\n');
};
```

- [ ] **Step 4:** `node --test tests/commands.requeue.test.cjs` → PASS。

- [ ] **Step 5:** Commit:

```bash
git add commands/requeue.cjs tests/commands.requeue.test.cjs
git commit -m "requeue: needs-code 回流(进行中→待办 + note 标记)"
```

---

## Task 13: worktree-create / worktree-list / worktree-discard 命令

**Files:**
- Create: `commands/worktree-create.cjs`、`commands/worktree-list.cjs`、`commands/worktree-discard.cjs`
- Create: `tests/commands.worktree-mgmt.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.worktree-mgmt.test.cjs`:

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const worktreeCreateCmd = require('../commands/worktree-create.cjs');
const worktreeListCmd = require('../commands/worktree-list.cjs');
const worktreeDiscardCmd = require('../commands/worktree-discard.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('wt-mgmt-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('worktree-create 建 worktree 输出 JSON;worktree-list 列出;worktree-discard 删', async () => {
  const proj = await setupProject([]);
  const c = JSON.parse(await captureStdout(() => worktreeCreateCmd(proj, ['7'])));
  assert.match(c.worktreePath, /task-7$/);
  assert.equal(c.branch, 'task-7');
  await captureStdout(() => worktreeCreateCmd(proj, ['9']));

  const l = JSON.parse(await captureStdout(() => worktreeListCmd(proj, [])));
  assert.deepEqual(l.worktrees.map(w => w.taskId).sort(), [7, 9]);

  await captureStdout(() => worktreeDiscardCmd(proj, ['7']));
  assert.ok(!fs.existsSync(c.worktreePath));
  const l2 = JSON.parse(await captureStdout(() => worktreeListCmd(proj, [])));
  assert.deepEqual(l2.worktrees.map(w => w.taskId), [9]);
});
```

- [ ] **Step 2:** 确认 FAIL。

- [ ] **Step 3: 实现** — 三个薄壳:

`commands/worktree-create.cjs`:

```javascript
'use strict';
const { createForTask } = require('../lib/worktree.cjs');

/** 主 loop 调:为任务建 worktree(替代裸跑 git,保证 symlink/分支约定一致) */
module.exports = async function worktreeCreate(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('worktree-create 需要 id 参数');
  const r = createForTask(projectRoot, idArg);
  process.stdout.write(JSON.stringify(r) + '\n');
};
```

`commands/worktree-list.cjs`:

```javascript
'use strict';
const { listOrphans } = require('../lib/worktree.cjs');

module.exports = async function worktreeList(projectRoot, _args) {
  process.stdout.write(JSON.stringify({ worktrees: listOrphans(projectRoot) }) + '\n');
};
```

`commands/worktree-discard.cjs`:

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

- [ ] **Step 4:** `node --test tests/commands.worktree-mgmt.test.cjs` → PASS。

- [ ] **Step 5:** Commit:

```bash
git add commands/worktree-create.cjs commands/worktree-list.cjs commands/worktree-discard.cjs tests/commands.worktree-mgmt.test.cjs
git commit -m "worktree mgmt: create/list/discard 三个 CLI 薄壳"
```

---

## Task 14: next --limit N

**Files:**
- Modify: `commands/next.cjs`
- Create: `tests/commands.next-limit.test.cjs`

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.next-limit.test.cjs`:

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTmpProjectFactory, captureStdout } = require('./_helpers.cjs');
const nextCmd = require('../commands/next.cjs');

const { tmpDir, setupProject } = createTmpProjectFactory('next-limit-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const ROWS = [
  { id: 1, desc: 'a', scope: 'w', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:00:00Z' },
  { id: 2, desc: 'b', scope: 'w', priority: '中', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
  { id: 3, desc: 'c', scope: 's', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:02:00Z' },
];

test('next --limit 3 返回数组,按优先级+ctime 排序', async () => {
  const proj = await setupProject(ROWS);
  const j = JSON.parse(await captureStdout(() => nextCmd(proj, ['--limit', '3'])));
  assert.ok(Array.isArray(j));
  assert.deepEqual(j.map(r => r.id), [1, 3, 2]);
});

test('next --limit 空队列输出 []', async () => {
  const proj = await setupProject([]);
  const out = await captureStdout(() => nextCmd(proj, ['--limit', '3']));
  assert.equal(out.trim(), '[]');
});

test('next 不带 --limit 仍返回单 obj(向后兼容)', async () => {
  const proj = await setupProject(ROWS);
  const j = JSON.parse(await captureStdout(() => nextCmd(proj, [])));
  assert.ok(!Array.isArray(j));
  assert.equal(j.id, 1);
});
```

- [ ] **Step 2:** 确认新文件 FAIL、现有 next 测试 PASS。

- [ ] **Step 3: 实现** — `commands/next.cjs` 的 `module.exports` 函数体改为(保留文件头 require 与 JSDoc,JSDoc 的 `_args` 参数说明更新为支持 `--limit N`):

```javascript
module.exports = async function next(projectRoot, args) {
  let limit = null;
  for (let i = 0; i < (args || []).length; i++) {
    if (args[i] === '--limit') { limit = parseInt(args[i + 1], 10) || null; i++; }
  }

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const todos = rows.filter(r => r.status === STATES.TODO);
  sortByPriorityAndCtime(todos);

  if (todos.length === 0) {
    writeHeartbeat(projectRoot, { phase: 'sleeping', currentTaskId: null });
    process.stdout.write((limit ? '[]' : 'null') + '\n');
    return;
  }

  if (limit) {
    const out = todos.slice(0, limit).map(r => {
      const rest = { ...r };
      delete rest._rowNumber;
      return rest;
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  const picked = todos[0];
  const out = { ...picked };
  delete out._rowNumber;
  process.stdout.write(JSON.stringify(out) + '\n');
};
```

- [ ] **Step 4:** `node --test tests/commands.next-limit.test.cjs` → PASS;`npm test` → 全 PASS。

- [ ] **Step 5:** Commit:

```bash
git add commands/next.cjs tests/commands.next-limit.test.cjs
git commit -m "next: --limit N 返回数组,无参保持单 obj 兼容"
```

---

## Task 15: recover 扫 worktree orphan

**Files:**
- Modify: `commands/recover.cjs`
- Create: `tests/commands.recover-orphan.test.cjs`

决策矩阵(spec §3.5):orphan = worktree 存在但任务不在"进行中"状态。

| 任务状态 | 分支已 merge? | 处理 |
|---|---|---|
| review | * | 保留(预期) |
| 不存在(进行中 sheet 找不到,已归档/被删) | 已 merge | 删 worktree + 分支 |
| 不存在 | 未 merge | 保留 + warn 日志(让人看) |
| todo(含刚被 recover 重排队的) | * | 转 review,保留 worktree |
| blocked | * | 保留 |

注意执行顺序:现有 recover 先把 IN_PROGRESS 重置为 TODO,**然后**扫 orphan —— 崩溃时正在并行执行的任务(IN_PROGRESS + worktree)会先变 TODO 再被 orphan 扫描转 review,符合"不一致默认保守"。

- [ ] **Step 1: 写失败测试** — 新建 `tests/commands.recover-orphan.test.cjs`:

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const { createForTask } = require('../lib/worktree.cjs');
const recoverCmd = require('../commands/recover.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('rec-orphan-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('崩溃恢复:进行中+worktree → 先重排队再转 review,worktree 保留', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'a', scope: 'web', priority: '高', status: '进行中', note: '', ctime: '' },
  ]);
  createForTask(proj, 1);
  await captureStdout(() => recoverCmd(proj, []));
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
});

test('review 状态的 orphan 不动(预期保留)', async () => {
  const proj = await setupProject([
    { id: 2, desc: 'b', scope: 'web', priority: '高', status: '已完成-待review', note: '', risk: 'x', ctime: '' },
  ]);
  createForTask(proj, 2);
  await captureStdout(() => recoverCmd(proj, []));
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-2')));
});

test('任务已不在进行中 sheet 且分支已 merge → 清 worktree+分支', async () => {
  const { execFileSync } = require('node:child_process');
  const proj = await setupProject([]);
  const { worktreePath } = createForTask(proj, 3);
  fs.writeFileSync(path.join(worktreePath, 'x.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-q', '-m', 'wip'], { cwd: worktreePath });
  execFileSync('git', ['merge', '--ff-only', 'task-3'], { cwd: proj });
  await captureStdout(() => recoverCmd(proj, []));
  assert.ok(!fs.existsSync(worktreePath));
});
```

- [ ] **Step 2:** 确认 FAIL。

- [ ] **Step 3: 实现** — `commands/recover.cjs`:文件头 require 区加:

```javascript
const { listOrphans, destroyForTask } = require('../lib/worktree.cjs');
const { transitionToReview } = require('../lib/done-core.cjs');
const { STATES: S } = require('../lib/states.cjs');
```

(原文件已 require STATES,直接用即可,不要重复别名 —— 上行仅当冲突时用。)函数主体最后(现有 `process.stdout.write(JSON.stringify({ recovered ... }))` **之前**,把输出挪到 orphan 处理后)插入,并把输出 JSON 扩为 `{ recovered, orphans }`:

```javascript
  // ── worktree orphan 扫描(并行模式崩溃兜底)──
  // 非 git 仓库 / 无 worktrees 目录时 listOrphans 返回 [] 或抛错,抛错按无 orphan 处理
  let orphanActions = [];
  let orphans = [];
  try { orphans = listOrphans(projectRoot); } catch (_) { orphans = []; }
  if (orphans.length > 0) {
    const rowsNow = await readRows(xlsxPath, SHEET_IN_PROGRESS);
    const logger = new Logger(projectRoot);
    for (const o of orphans) {
      const task = rowsNow.find(r => String(r.id) === String(o.taskId));
      if (!task) {
        if (o.branchMerged) {
          destroyForTask(projectRoot, o.taskId, { force: true, deleteBranch: true });
          orphanActions.push({ taskId: o.taskId, action: 'cleaned' });
        } else {
          logger.warn(`orphan worktree task-${o.taskId}: 任务不在进行中 sheet 且分支未 merge,保留待人工`);
          orphanActions.push({ taskId: o.taskId, action: 'kept-unmerged' });
        }
        continue;
      }
      if (task.status === STATES.REVIEW || task.status === STATES.BLOCKED) {
        orphanActions.push({ taskId: o.taskId, action: 'kept-expected' });
        continue;
      }
      // todo(含刚被上面重排队的)→ 不一致,转 review 保留 worktree
      await transitionToReview(xlsxPath, task._rowNumber,
        `recover 发现 worktree task-${o.taskId} 与任务状态(${task.status})不一致,转 review。`
        + `worktree 保留在 .tasks/worktrees/task-${o.taskId}`,
        logger, projectRoot, task.id);
      orphanActions.push({ taskId: o.taskId, action: 'to-review' });
    }
  }
  process.stdout.write(JSON.stringify({ recovered: stuck.length, orphans: orphanActions }) + '\n');
```

改造时注意:现有函数对 `stuck.length === 0` 有 early-return(输出 `{recovered: 0}`)—— 删掉 early-return,让空 stuck 也走到 orphan 扫描(stuck 为空就跳过 withWorkbook 写)。最终输出统一为 `{recovered, orphans}`。现有断言 `{recovered: N}` 的测试若精确匹配整个 JSON,需放宽为 `assert.equal(j.recovered, N)`。

- [ ] **Step 4:** `node --test tests/commands.recover-orphan.test.cjs` → PASS;`npm test` → 全 PASS(注意修现有 recover 测试的输出断言)。

- [ ] **Step 5:** Commit:

```bash
git add commands/recover.cjs tests/commands.recover-orphan.test.cjs tests/
git commit -m "recover: 扫 worktree orphan 按矩阵处理(不一致→review,已归档已merge→清)"
```

---

## Task 16: tasks.cjs 注册新命令

**Files:**
- Modify: `tasks.cjs`

- [ ] **Step 1:** `tasks.cjs` 的 `KNOWN_COMMANDS` 数组(当前以 `'watchdog', 'reopen',` 结尾)追加一行:

```javascript
  'plan-batch', 'claim-batch', 'worktree-create', 'worktree-list', 'worktree-discard',
  'done-in-worktree', 'merge-task', 'requeue',
```

(dispatcher 是 `require('./commands/${cmd}.cjs')` 约定式加载,文件名即命令名,无需别的注册。)

- [ ] **Step 2: smoke test:**

```bash
cd ~/.claude/skills/task-queue && node tasks.cjs plan-batch /tmp/nonexistent 2>&1 | head -3
```

Expected: `[task-queue] 错误: project.config.js 不存在...`(命令已被识别,只是项目不存在)。

- [ ] **Step 3:** Commit:

```bash
git add tasks.cjs
git commit -m "tasks.cjs: 注册 8 个并行相关命令"
```

---

## Task 17: 模板写入推荐并行配置

**Files:**
- Modify: `templates/project.config.js`

- [ ] **Step 1:** 读 `templates/project.config.js`,在 `module.exports = {` 块内(`sameDayShareVersion` 字段附近,看模板实际字段排布)追加静态块:

```javascript
  // 并行执行(v2):code 任务进独立 worktree 并发跑,non-code(调研/问答)不开 worktree。
  // allowSameScope=true 时同 scope 任务由主 Claude 判断 desc 文件不重叠后放行,撞了有 rebase→review 兜底。
  // 存量项目没有本字段 = 关闭(纯串行,行为不变)。
  parallel: {
    enabled: true,
    maxConcurrency: 3,
    allowSameScope: true,
  },
```

- [ ] **Step 2: 验证渲染** — init-write 的 render 只替换 `__X__` 占位符,静态块原样保留:

```bash
cd ~/.claude/skills/task-queue && node -e "
const fs=require('fs');
const tpl=fs.readFileSync('templates/project.config.js','utf8');
if(!/parallel:\s*{/.test(tpl)) { console.error('模板缺 parallel 块'); process.exit(1); }
console.log('模板 OK');
"
```

跑 init-write 相关现有测试:`npm test` → 全 PASS(若有测试快照断言模板渲染产物,按新增块更新断言)。

- [ ] **Step 3:** Commit:

```bash
git add templates/project.config.js tests/
git commit -m "init 模板: 新项目默认写入推荐并行配置(enabled+allowSameScope)"
```

---

## Task 18: loop-prompt.md 并行分支 + worker 模板

**Files:**
- Modify: `loop-prompt.md`

无自动化测试(prompt 文档),靠 Task 20/21 集成测试覆盖 CLI 链路,本任务人工 review 文案。

- [ ] **Step 1: 替换 Step 1 整节** — 现有 `## Step 1: 取下一条任务` 整节替换为:

````markdown
## Step 1: 取任务(串行 / 并行分流)

读 `.tasks/project.config.js` 的 `parallel.enabled`:

### Step 1a: 串行模式(parallel.enabled=false / 字段缺失)

```
node ~/.claude/skills/task-queue/tasks.cjs next ${PROJECT_ROOT}
```

- 输出 `null` → 跳到 Step 5
- 输出 JSON → 进入 Step 2(原串行派发,完全不变)

### Step 1b: 并行模式(parallel.enabled=true)

```
node ~/.claude/skills/task-queue/tasks.cjs plan-batch ${PROJECT_ROOT}
```

输出 `{candidates, scopeMutex, maxConcurrency, allowSameScope}`。

- `candidates` 空 → 跳到 Step 5
- `candidates` 只有 1 条 → 退回 Step 1a 串行路径处理这 1 条(不值得开 worktree)
- ≥ 2 条 → 你自己做编排(不调外部命令):

**编排规则:**

1. **标 lane**:每条候选判定 `code`(desc 涉及改代码/改仓库文件)或 `non-code`(调研/问答/分析,无需改文件)。拿不准一律 code。note 顶部含 `[needs-code` 标记的强制 code。
2. **scope 互斥**:`scopeMutex` 里的 pair 默认不同批;`allowSameScope=true` 时,若两条 desc 明显改不同文件/目录可同批。non-code 不占 scope 互斥。
3. note 含 "依赖 #N" 且 #N 不在本批 → 推迟。
4. 总数 ≤ `maxConcurrency`。

输出一行编排理由(日志复盘用),例:
> 本轮并行 #7(code) #9(code) #11(non-code),理由:7/9 跨目录,11 纯调研

然后:

```
node ~/.claude/skills/task-queue/tasks.cjs claim-batch ${PROJECT_ROOT} <id1> <id2> ...
```

→ 进入 Step 2b。
````

- [ ] **Step 2: 在 Step 2(现"派发 subagent 执行任务")之后插入新节 Step 2b:**

````markdown
## Step 2b(并行模式): 建 worktree + 并发派 worker

**对每条 code 任务**先建 worktree(主 loop 跑):

```
node ~/.claude/skills/task-queue/tasks.cjs worktree-create ${PROJECT_ROOT} <id>
```

失败(报"已存在"以外的错)→ 该任务按串行 Step 2 的派发失败处理(claim 已完成,直接 block)。

然后**同一条 message 里**为每条任务发一个 Agent 调用(并发 tool_use),`model` = task.model || desiredModel:

- code 任务 → prompt 用本文件末尾 **## Parallel Code Worker 模式** 模板,填入 PROJECT_ROOT / TASK_ID / WORKTREE 路径 / 任务 desc / scope
- non-code 任务 → prompt 用 **## Non-code Worker 模式** 模板,填入 PROJECT_ROOT / TASK_ID / 任务 desc

## Step 3b(并行模式): 收 worker 返回,收尾

worker 返回顺序不定,**non-code 先回先归档,不等 code**。

**non-code worker 返回:**

- 末行 `STATUS: done` → `node ... done ${PROJECT_ROOT} <id> "<返回正文(完整答案)>" --expect-clean`
  - 命令把脏仓库自动还原+转 review,你无需自查 git status
- 末行 `STATUS: needs-code` →
  - 该任务 note 里**已有** `[needs-code` 标记(claim-batch 输出里看)→ 二次回流,`review <id> "二次 needs-code,请人工拆解: <worker 说明前 100 字>"`
  - 否则 → `requeue ${PROJECT_ROOT} <id> "<worker 说明前 200 字>"`(下一轮强制 code lane)
- 末行 `STATUS: block` / 无 STATUS 行 → `block <id> "<原因>"`

**code worker 全部返回后,按返回顺序逐条串行:**

- 末行 `STATUS: done`(worker 已跑过 done-in-worktree 且 ok:true)→
  ```
  node ~/.claude/skills/task-queue/tasks.cjs merge-task ${PROJECT_ROOT} <id> "<worker 返回的 summary>"
  ```
  - `{ok:true}` → 完成,worktree 已清
  - `{ok:false}` → 已自动转 review,worktree 保留,**不要重试**
- 末行 `STATUS: review` → `review <id> "<worker 给的风险>"`(worktree 保留)
- 末行 `STATUS: block` / Agent 调用失败 / 无 STATUS 行 → `block <id> "<原因前 200 字>"`(worktree 保留)

**每条任务收尾后立刻双通道推送**(同串行 S5 文案格式):PushNotification + test-push。

全部收尾后 → Step 5。
````

- [ ] **Step 3: 文件末尾(现 ## Subagent 模式 之后)追加两个 worker 模板节:**

````markdown
---

## Parallel Code Worker 模式

**仅当主 loop 以并行模式派发你执行单条 code 任务时按本节执行。** prompt 顶部有 `PROJECT_ROOT=` / `TASK_ID=` / `WORKTREE=`(形如 `<root>/.tasks/worktrees/task-N`)三行。

1. **只在 WORKTREE 目录内工作**。读代码、改代码都以 WORKTREE 为根。
2. 按任务 desc 执行;严守 scope、CLAUDE.md 规范、S3 同款安全护栏。
3. 改完在 WORKTREE 内跑 `buildCommands[scope]` 验证;失败重试 1 次,仍败 → 不 commit,直接返回。
4. build 通过 → `node ~/.claude/skills/task-queue/tasks.cjs done-in-worktree ${PROJECT_ROOT} ${TASK_ID}`
   - 输出 `ok:true` → 成功;`ok:false`(改了依赖文件)→ 按失败返回,reason 写进返回正文

**与串行 Subagent 模式的区别(重要,全部禁止):**
- ❌ claim / done / review / block / mark-done(主 loop 管 Excel)
- ❌ set-checklist / tick-checklist 等 checklist 命令
- ❌ heartbeat 上报
- ❌ PushNotification / test-push(主 loop 统一推)
- ❌ 触碰主仓库工作区(${PROJECT_ROOT} 下 WORKTREE 之外的文件)
- ❌ 改 package.json / 任何锁文件

**返回格式:**
- 正文 = 1-2 句 summary(改了什么/关键决策,主 loop 直接用作 commit 归档的 summary)
- 失败时正文 = 原因(风险或疑问)
- 最后一行三选一:`STATUS: done` / `STATUS: review` / `STATUS: block`

## Non-code Worker 模式

**仅当主 loop 以并行模式派发你执行单条 non-code 任务时按本节执行。** prompt 顶部有 `PROJECT_ROOT=` / `TASK_ID=` 两行。

1. 在主仓库内**只读**:可以读代码/文档/git log,可以联网调研。
2. **禁止改任何 git 跟踪文件,禁止 commit**。Excel/checklist/heartbeat/推送同样禁止(主 loop 管)。
3. 产出:
   - 篇幅长(> 30 行)→ 写 `${PROJECT_ROOT}/.tasks/reports/task-${TASK_ID}.md`(目录不存在先 mkdir -p),返回正文给摘要 + 报告路径
   - 篇幅短 → 直接写在返回正文
   - 返回正文会被主 loop 原样用作 done summary(dashboard 完成区展示),按"回答型任务"标准放开写
4. **执行中发现其实需要改代码** → 什么都不要改,返回正文写清楚要改什么/为什么,最后一行 `STATUS: needs-code`

**返回格式:** 最后一行三选一:`STATUS: done` / `STATUS: needs-code` / `STATUS: block`
````

- [ ] **Step 4: 同步小修** — 文件开头第 3 行说明并行能力一句话带过;`## Step 3`/`## Step 4`/`## Step 5` 标题后各加一句"(并行模式见 Step 3b)"式交叉引用。Step 5 逻辑不变。

- [ ] **Step 5: 人工通读一遍**全文,确认串行路径文字零改动、新旧节编号无冲突、模板占位符(${...})风格统一。

- [ ] **Step 6:** Commit:

```bash
git add loop-prompt.md
git commit -m "loop-prompt: 并行分支(plan/claim-batch/worker 派发/串行 merge)+ 双 worker 模板"
```

---

## Task 19: dashboard 暴露 currentTaskIds

**Files:**
- Modify: `commands/dashboard-server.cjs`、`web/`(以现状为准)
- Create: `tests/dashboard-server.parallel-ids.test.cjs`

heartbeat 双写后旧 UI 读 `currentTaskId`/`currentTaskDesc`(claim-batch 已写聚合 desc)**不改也能用**;本任务只把数组暴露出 API + UI 多任务时逐条列出。

- [ ] **Step 1: 调研现状:**

```bash
cd ~/.claude/skills/task-queue && grep -n "currentTaskId\|currentTaskDesc" commands/dashboard-server.cjs web/ -r | head -30
```

- [ ] **Step 2: API 暴露** — dashboard-server 返回 heartbeat 的接口处,确保整个 heartbeat 对象透传(若是字段白名单式拼装,加 `currentTaskIds: hb.currentTaskIds || []`)。

- [ ] **Step 3: 写 API 测试** — 新建 `tests/dashboard-server.parallel-ids.test.cjs`(server 启动/注册模式参照现有 dashboard-server 测试文件,先 `ls tests/ | grep dashboard` 找一个抄结构):

```javascript
// 两个用例:
// 1. heartbeat 写 currentTaskIds:[7,9] → GET 项目详情 API 返回 currentTaskIds 数组
// 2. heartbeat 只有旧 currentTaskId:5 → API 返回 currentTaskIds:[5](readHeartbeat 升级兜底)
// 具体 startServer/registry 样板从现有 dashboard 测试文件复制,断言:
//   assert.deepEqual(body.<heartbeat 字段路径>.currentTaskIds, [7, 9]);
```

(heartbeat 在响应里的具体路径以现有测试文件为准 —— 调研后照实写,不要猜。)

- [ ] **Step 4: UI** — 找到渲染 `currentTaskDesc` 的模板处:`currentTaskIds.length > 1` 时把聚合 desc 按 ` ｜ ` 拆行显示(每行一条 `#id desc`),单任务保持现状。CSS 按现有卡片样式微调。

- [ ] **Step 5:** `node --test tests/dashboard-server.parallel-ids.test.cjs` → PASS;`npm test` 全 PASS;`node tasks.cjs dashboard` 手工开浏览器看单/多任务两种渲染。

- [ ] **Step 6:** Commit:

```bash
git add commands/dashboard-server.cjs web/ tests/dashboard-server.parallel-ids.test.cjs
git commit -m "dashboard: 暴露 currentTaskIds,多任务并行逐条展示"
```

---

## Task 20: e2e happy path(2 code + 1 non-code)

**Files:**
- Create: `tests/integration.parallel-happy.test.cjs`

- [ ] **Step 1: 写测试:**

```javascript
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { createTmpGitProjectFactory, captureStdout } = require('./_helpers.cjs');
const claimBatchCmd = require('../commands/claim-batch.cjs');
const worktreeCreateCmd = require('../commands/worktree-create.cjs');
const mergeTaskCmd = require('../commands/merge-task.cjs');
const doneCmd = require('../commands/done.cjs');

const { tmpDir, setupProject } = createTmpGitProjectFactory('integ-happy-');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('e2e: claim-batch → 2 code worker(子进程)+ 1 non-code → merge ×2 + expect-clean done → 全归档', async () => {
  const proj = await setupProject([
    { id: 1, desc: 'web 改', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:00:00Z' },
    { id: 2, desc: 'svc 改', scope: 'service', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:01:00Z' },
    { id: 3, desc: '调研 X 是什么', scope: 'web', priority: '高', status: '待办', note: '', ctime: '2026-01-01T00:02:00Z' },
  ]);
  fs.writeFileSync(`${proj}/.tasks/project.config.js`, `
    module.exports = {
      scopes: { web: { dir: '.', autoCommit: true }, service: { dir: '.', autoCommit: true } },
      buildCommands: { web: 'true', service: 'true' },
      versionFiles: { web: 'package.json', service: 'package.json' },
      changelogFiles: { web: 'CHANGELOG.md', service: 'CHANGELOG.md' },
      inferModule: (_, s) => s,
      commitMessage: ({ scope, desc, version }) => scope + ': ' + desc + ' v' + version,
      parallel: { enabled: true, maxConcurrency: 3, allowSameScope: true },
    };
  `);

  await captureStdout(() => claimBatchCmd(proj, ['1', '2', '3']));
  await captureStdout(() => worktreeCreateCmd(proj, ['1']));
  await captureStdout(() => worktreeCreateCmd(proj, ['2']));

  // 模拟 code worker:改文件 + done-in-worktree(子进程,验证 CLI 链路)
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-1', 'web.txt'), 'web work');
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-2', 'svc.txt'), 'svc work');
  for (const id of ['1', '2']) {
    const r = spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done-in-worktree', proj, id], { encoding: 'utf8' });
    assert.equal(r.status, 0, `done-in-worktree #${id}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).ok, true);
  }

  // 模拟 non-code worker:写报告(在 .tasks/ 下,不脏仓库)→ 主 loop expect-clean 归档
  fs.mkdirSync(path.join(proj, '.tasks', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.tasks', 'reports', 'task-3.md'), '# 调研报告\n...');
  await doneCmd(proj, ['3', 'X 是...(摘要),全文见 .tasks/reports/task-3.md', '--expect-clean']);

  // 主 loop 串行 merge
  for (const id of ['1', '2']) {
    const j = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, [id, `任务${id}完成`])));
    assert.equal(j.ok, true, `merge-task #${id}: ${j.reason || ''}`);
  }

  const inProg = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  const arch = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_ARCHIVED);
  assert.equal(inProg.length, 0);
  assert.equal(arch.length, 3);
  assert.ok(!fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
  assert.ok(!fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-2')));
  const log = execFileSync('git', ['log', '--oneline'], { cwd: proj }).toString();
  assert.match(log, /web:/);
  assert.match(log, /service:/);
  assert.ok(!log.includes('调研'), 'non-code 任务不产生 commit');
  // heartbeat 清场
  const hb = JSON.parse(fs.readFileSync(path.join(proj, '.tasks', 'run', 'heartbeat.json'), 'utf8'));
  assert.deepEqual(hb.currentTaskIds, []);
});
```

- [ ] **Step 2:** `node --test tests/integration.parallel-happy.test.cjs` → PASS。

- [ ] **Step 3:** Commit:

```bash
git add tests/integration.parallel-happy.test.cjs
git commit -m "test: e2e 并行 happy path(2 code + 1 non-code 混合批次)"
```

---

## Task 21: e2e 故障注入

**Files:**
- Create: `tests/integration.parallel-faults.test.cjs`

- [ ] **Step 1: 写测试** — 5 个故障场景(文件头 require / writeParallelCfg / setupProject 与 Task 20 相同,此处只列用例体;config 用 `inferModule: () => 'web'` 单 scope 版,见 Task 11 的 writeParallelCfg):

```javascript
test('故障(a) 两 worker 改同文件 → 第二条 merge 冲突转 review,worktree 保留', async () => {
  const proj = await setupProject([
    { id: 1, desc: 't1', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
    { id: 2, desc: 't2', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1', '2']));
  await captureStdout(() => worktreeCreateCmd(proj, ['1']));
  await captureStdout(() => worktreeCreateCmd(proj, ['2']));
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-1', 'shared.txt'), 'v1');
  fs.writeFileSync(path.join(proj, '.tasks', 'worktrees', 'task-2', 'shared.txt'), 'v2');
  for (const id of ['1', '2']) {
    spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done-in-worktree', proj, id], { encoding: 'utf8' });
  }
  const j1 = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['1', 's1'])));
  assert.equal(j1.ok, true);
  const j2 = JSON.parse(await captureStdout(() => mergeTaskCmd(proj, ['2', 's2'])));
  assert.equal(j2.ok, false);
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows.find(r => String(r.id) === '2').status, '已完成-待review');
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-2')));
});

test('故障(b) 用户解决冲突后 merge-task 重试成功(人工回路)', async () => {
  // 复刻 (a) 到冲突态后:人工在 worktree 里 rebase --abort 已发生,模拟用户改 worktree 文件与 main 一致再 commit
  // 然后任务先 reply/改状态? —— 简化:直接把 task-2 状态写回 进行中(模拟用户 reopen),
  // 在 worktree 里 git rebase main 手工跑通(无冲突版),再 mergeTaskCmd(proj, ['2','retry']) 断言 ok:true。
  // 实现时若状态机阻碍(review→进行中 非法),改用 withWorkbook 直接写状态模拟人工修表。
});

test('故障(c) non-code 任务弄脏仓库 → done --expect-clean 还原 + review(已在单测覆盖,此处端到端跑 CLI 子进程)', async () => {
  const proj = await setupProject([
    { id: 1, desc: '调研', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  fs.writeFileSync(path.join(proj, 'README.md'), '# polluted\n');
  const r = spawnSync('node', [path.join(__dirname, '..', 'tasks.cjs'), 'done', proj, '1', '结论', '--expect-clean'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), '# test\n');
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
});

test('故障(d) needs-code 一次回流成功,二次转 review', async () => {
  const proj = await setupProject([
    { id: 1, desc: '看看要不要改', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  await captureStdout(() => requeueCmd(proj, ['1', '要改 LoginPage'])); // 第一次回流
  let rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '待办');
  assert.match(String(rows[0].note), /\[needs-code/);
  // 第二次:主 loop 看到 note 已有标记 → 调 review(模拟 loop-prompt 的判断)
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  const reviewCmd = require('../commands/review.cjs');
  await captureStdout(() => reviewCmd(proj, ['1', '二次 needs-code,请人工拆解']));
  rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
});

test('故障(e) kill -9 等价:claim 后直接 recover → 任务转 review,worktree 保留', async () => {
  const proj = await setupProject([
    { id: 1, desc: 't', scope: 'web', priority: '高', status: '待办', note: '', ctime: '' },
  ]);
  writeParallelCfg(proj);
  await captureStdout(() => claimBatchCmd(proj, ['1']));
  await captureStdout(() => worktreeCreateCmd(proj, ['1']));
  const recoverCmd = require('../commands/recover.cjs');
  await captureStdout(() => recoverCmd(proj, []));
  const rows = await readRows(path.join(proj, '.tasks', 'tasks.xlsx'), SHEET_IN_PROGRESS);
  assert.equal(rows[0].status, '已完成-待review');
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'worktrees', 'task-1')));
});
```

故障(b) 写成可执行版本(按注释思路落实);若 review→进行中 状态机确实不通,用 `withWorkbook` 直写状态模拟人工修表并在测试注释里说明。

- [ ] **Step 2:** `node --test tests/integration.parallel-faults.test.cjs` → PASS;`npm test` 全套 PASS(**回归底线:enabled=false 的所有旧测试零失败**)。

- [ ] **Step 3:** Commit:

```bash
git add tests/integration.parallel-faults.test.cjs
git commit -m "test: e2e 故障注入(冲突/人工重试/脏仓库/needs-code 二次/崩溃恢复)"
```

---

## Task 22: SKILL.md / README 文档

**Files:**
- Modify: `SKILL.md`、`README.md`

- [ ] **Step 1:** `SKILL.md` 子命令速查表追加 8 行(plan-batch / claim-batch / worktree-create / worktree-list / worktree-discard / done-in-worktree / merge-task / requeue,用途一句话);"必读约束"节加一条:并行模式下 worker 禁碰 Excel,合并失败转 review 保留 worktree,人工回路 `merge-task <id>` 重试 / `worktree-discard <id>` 放弃。

- [ ] **Step 2:** `SKILL.md` 增 `## §parallel` 小节(对用户):怎么开(`parallel.enabled`,新 init 默认开)、并发上限与 token/build 成本提示、同 scope 并行由 AI 判独立、deps 变更任务自动转 review 走人工。

- [ ] **Step 3:** `README.md` 特性列表加一行并行执行简介。

- [ ] **Step 4:** Commit:

```bash
git add SKILL.md README.md
git commit -m "docs: 并行执行 v2 用户文档(命令速查/开启方式/限制)"
```

---

## Task 23: spec 对账 self-review

完成 Task 1-22 后逐项核对(发现缺口 → 补任务再走一遍本清单):

- [ ] spec §1 架构图每个箭头都有实现:plan-batch→编排→claim-batch→worktree-create→双 worker→non-code 即归档→串行 merge→推送→调度
- [ ] spec §2 双 lane 表 5 行(判定/隔离/产出/完成/并发)在 loop-prompt + 命令里都有落点
- [ ] needs-code 一次回流(requeue)+ 二次转 review 有测试(faults d)
- [ ] spec §3.5 worktree 生命周期 4 种删/留路径有测试(merge 成功清/冲突留/orphan 矩阵/discard)
- [ ] spec §6 异常表 3 个新增行有测试:non-code 脏(faults c)、needs-code 二次(faults d)、空分支归档(merge-task ahead=0 路径 —— 若无显式测试,补一个:createForTask 后不改文件直接 done-in-worktree + merge-task,断言归档)
- [ ] spec §7 测试矩阵全落实;`parallel.enabled=false` 回归:`npm test` 旧用例零失败
- [ ] `git log --oneline` 检查本期所有 commit message 符合仓库惯例
- [ ] 用 `aggregates` 项目真机冒烟:手动在 `.tasks/project.config.js` 加 `parallel` 块 → 加 2 条互不相干小任务 + 1 条调研任务 → tmux 起 loop → 观察 dashboard 多任务展示与最终 commit/归档

---

## 备注

- **Task 8 是高危重构**,执行者务必以当前 done.cjs 文件为准逐函数搬移,搬完先跑全套再继续;搬移过程中发现本 plan 引用的行号/函数名与实际有出入,以实际代码为准,保持"零行为变更"这个目标不动摇。
- **dashboard(Task 19)写得宽**:46KB 的 dashboard-server 结构以现状为准,先调研后动手。
- 串行模式语义全程不动 —— 这是回归保护的底线。
