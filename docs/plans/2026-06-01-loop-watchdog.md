# Loop 看门狗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 task-queue 加一个 launchd 常驻看门狗，检测心跳停更 >30min 但本应在跑的非-hidden loop 并自动无头重启，连续 3 次失败则放弃 + 桌面告警。

**Architecture:** 一次性 Node 脚本 `node tasks.cjs watchdog`，由 launchd `StartInterval 60` 每 60s 拉起、扫一遍即退出（短命进程，自身不会泄漏/掉线）。决策核心是纯函数 `decideProject`，副作用（tmux kill/启动、桌面告警）通过注入的 impl 执行，便于单测。启动逻辑抽到共享 lib，与 dashboard 的"复制启动命令"复用。

**Tech Stack:** Node.js (CommonJS `.cjs`)、`node:test`、tmux、launchd（plist + launchctl）、osascript（桌面告警，复用 test-push）。

设计依据：`docs/specs/2026-06-01-loop-watchdog-design.md`。

---

## 文件结构

| 文件 | 类型 | 职责 |
|---|---|---|
| `lib/launch-command.cjs` | 新增 | `sessionName(slug)`、`shellSingleQuote(s)`、`buildLoopPrompt(root)`、`renderStartScript(root, slug)`（人用、含 attach）、`launchHeadless(root, slug, execFileSyncImpl)`（无头、不 attach） |
| `commands/dashboard-server.cjs` | 改 | `handleLoopCommand` / `scanSessionName` 改调 `lib/launch-command.cjs`，消除重复 |
| `lib/watchdog-state.cjs` | 新增 | 读写 `~/.task-queue/watchdog-state.json`（env `TASK_QUEUE_WATCHDOG_STATE_PATH` 可覆盖） |
| `commands/watchdog.cjs` | 新增 | `decideProject`（纯）、`runPass(deps)`、`renderPlist(...)`，及子动作 `run`/`install`/`uninstall`/`status` 分发 |
| `tasks.cjs` | 改 | `KNOWN_COMMANDS` + `COMMANDS_NOT_REQUIRING_PROJECT_ROOT` 注册 `watchdog` |
| `tests/lib.launch-command.test.cjs` | 新增 | launch-command lib 单测 |
| `tests/lib.watchdog-state.test.cjs` | 新增 | 状态读写单测 |
| `tests/commands.watchdog.test.cjs` | 新增 | `decideProject` + `runPass` + `renderPlist` 单测 |

常量（定义在 `commands/watchdog.cjs` 顶部并 export 供测试引用）：
`STALE_MS = 30*60*1000`、`GRACE_MS = 5*60*1000`、`MAX_RESTARTS = 3`、`WATCHDOG_LABEL = 'com.taskqueue.watchdog'`。

---

## Task 1: 抽取 launch-command 共享 lib（重构，dashboard 保持绿）

**Files:**
- Create: `lib/launch-command.cjs`
- Modify: `commands/dashboard-server.cjs`（`scanSessionName` L256-263、`shellSingleQuote` L505-507、`handleLoopCommand` L520-561）
- Test: `tests/lib.launch-command.test.cjs`，并复跑 `tests/dashboard-server.loop-command.test.cjs`

- [ ] **Step 1: 写失败测试 `tests/lib.launch-command.test.cjs`**

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lc = require('../lib/launch-command.cjs');

test('sessionName 规约为 task-queue-loop-<slug>', () => {
  assert.equal(lc.sessionName('aggregates'), 'task-queue-loop-aggregates');
});

test('shellSingleQuote 转义单引号', () => {
  assert.equal(lc.shellSingleQuote("a'b"), "'a'\\''b'");
});

test('buildLoopPrompt 替换 ${PROJECT_ROOT} 且去尾部空白', () => {
  const prompt = lc.buildLoopPrompt('/tmp/some-proj');
  assert.ok(!prompt.includes('${PROJECT_ROOT}'), 'PROJECT_ROOT 应被替换');
  assert.ok(prompt.includes('/tmp/some-proj'), '应含真实根路径');
  assert.equal(prompt, prompt.replace(/\s+$/, ''), '应无尾部空白');
});

test('renderStartScript 产出含 attach 的人用三段脚本', () => {
  const s = lc.renderStartScript('/tmp/some-proj', 'demo');
  assert.ok(s.startsWith("SESSION='task-queue-loop-demo'"));
  assert.ok(s.includes('tmux new-session -ds "$SESSION"'));
  assert.ok(s.includes('tmux send-keys -t "$SESSION"'));
  assert.ok(s.includes('tmux attach -t "$SESSION"'));
  assert.ok(s.includes("-c '/tmp/some-proj'"));
});

test('launchHeadless 调 new-session + send-keys 且绝不 attach', () => {
  const calls = [];
  const mockExec = (bin, args) => { calls.push([bin, ...args]); };
  const session = lc.launchHeadless('/tmp/some-proj', 'demo', mockExec);
  assert.equal(session, 'task-queue-loop-demo');
  const flat = calls.map(c => c.join(' '));
  assert.ok(flat.some(c => c.startsWith('tmux new-session -ds task-queue-loop-demo')), 'should new-session detached');
  assert.ok(flat.some(c => c.startsWith('tmux send-keys -t task-queue-loop-demo')), 'should send-keys');
  assert.ok(!flat.some(c => c.includes('attach')), '无头绝不能 attach');
  assert.ok(flat.some(c => c.includes('/loop') && c.includes('claude --dangerously-skip-permissions')), '应注入 claude /loop');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/lib.launch-command.test.cjs`
Expected: FAIL，`Cannot find module '../lib/launch-command.cjs'`

- [ ] **Step 3: 实现 `lib/launch-command.cjs`**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync: realExecFileSync } = require('node:child_process');

const LOOP_PROMPT_PATH = path.join(__dirname, '..', 'loop-prompt.md');

/** slug → tmux session 名。 */
function sessionName(slug) {
  return `task-queue-loop-${slug}`;
}

/** POSIX 单引号转义。 */
function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** 读 loop-prompt.md，替换 ${PROJECT_ROOT}，去尾部空白。 */
function buildLoopPrompt(root) {
  let prompt = fs.readFileSync(LOOP_PROMPT_PATH, 'utf8');
  prompt = prompt.replace(/\$\{PROJECT_ROOT\}/g, root);
  return prompt.replace(/\s+$/, '');
}

/** send-keys 那一行（外层 bash 双引号串；$(cat …) 留给 tmux 内 shell 展开）。 */
function sendKeysLine() {
  return 'tmux send-keys -t "$SESSION" '
    + '"claude --dangerously-skip-permissions \\"/loop \\$(cat \'$PROMPT_FILE\')\\"" '
    + 'Enter';
}

/** 人用：可粘贴的 tmux 四段启动脚本（含 attach）。 */
function renderStartScript(root, slug) {
  const prompt = buildLoopPrompt(root);
  return [
    `SESSION='${sessionName(slug)}'`,
    `PROMPT_FILE="\${TMPDIR:-/tmp}/tq-loop-${slug}.prompt"`,
    `cat > "$PROMPT_FILE" <<'TQ_PROMPT_END'`,
    prompt,
    `TQ_PROMPT_END`,
    `tmux new-session -ds "$SESSION" -c ${shellSingleQuote(root)} "$SHELL"`,
    sendKeysLine(),
    `tmux attach -t "$SESSION"`,
  ].join('\n');
}

/**
 * 无头启动 loop：写 prompt 文件 → tmux new-session -ds → send-keys。绝不 attach。
 * @param {string} root 项目根
 * @param {string} slug
 * @param {Function} [execFileSyncImpl] 注入用，默认真实 execFileSync
 * @returns {string} session 名
 */
function launchHeadless(root, slug, execFileSyncImpl = realExecFileSync) {
  const session = sessionName(slug);
  const promptFile = path.join(os.tmpdir(), `tq-loop-${slug}.prompt`);
  fs.writeFileSync(promptFile, buildLoopPrompt(root));
  const shell = process.env.SHELL || '/bin/zsh';
  execFileSyncImpl('tmux', ['new-session', '-ds', session, '-c', root, shell], { stdio: 'ignore' });
  const claudeLine = `claude --dangerously-skip-permissions "/loop $(cat '${promptFile}')"`;
  execFileSyncImpl('tmux', ['send-keys', '-t', session, claudeLine, 'Enter'], { stdio: 'ignore' });
  return session;
}

module.exports = { sessionName, shellSingleQuote, buildLoopPrompt, renderStartScript, launchHeadless };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/lib.launch-command.test.cjs`
Expected: PASS（5 个 test）

- [ ] **Step 5: 改 `commands/dashboard-server.cjs` 复用 lib**

顶部 require 区（L17-29 附近）加：
```javascript
const { sessionName: lcSessionName, renderStartScript } = require('../lib/launch-command.cjs');
```
把 `scanSessionName`（L261-263）实现改为委托：
```javascript
function scanSessionName(slug) {
  return lcSessionName(slug);
}
```
把 `handleLoopCommand`（L520-561）里从 `const promptPath = ...` 到拼 `command` 的整段，替换为：
```javascript
  let command;
  try {
    command = renderStartScript(entry.root, slug);
  } catch (err) {
    return sendJson(res, 500, { error: `读取 loop-prompt.md 失败: ${err.message}` });
  }
  sendJson(res, 200, { command, projectRoot: entry.root, sessionName: scanSessionName(slug) });
```
删除现在不再用到的顶层 `shellSingleQuote`（L505-507），因为已迁入 lib。（确认 dashboard-server 内无其它引用：`grep -n shellSingleQuote commands/dashboard-server.cjs` 应只剩 0 处。）

- [ ] **Step 6: 跑 dashboard loop-command 回归测试确认仍绿**

Run: `node --test tests/dashboard-server.loop-command.test.cjs`
Expected: PASS（原 4 个 test 全过，证明重构未改行为）

- [ ] **Step 7: Commit**

```bash
git add lib/launch-command.cjs tests/lib.launch-command.test.cjs commands/dashboard-server.cjs
git commit -m "refactor: 抽取 lib/launch-command（dashboard 与 watchdog 共用启动逻辑）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 看门狗状态读写 lib

**Files:**
- Create: `lib/watchdog-state.cjs`
- Test: `tests/lib.watchdog-state.test.cjs`

- [ ] **Step 1: 写失败测试 `tests/lib.watchdog-state.test.cjs`**

```javascript
'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-state-'));
process.env.TASK_QUEUE_WATCHDOG_STATE_PATH = path.join(tmp, 'watchdog-state.json');
const ws = require('../lib/watchdog-state.cjs');

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.TASK_QUEUE_WATCHDOG_STATE_PATH; });
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_WATCHDOG_STATE_PATH); } catch (_) {} });

test('文件不存在 → 空对象', () => {
  assert.deepEqual(ws.readState(), {});
});

test('write 后 read 回来一致', () => {
  ws.writeState({ demo: { consecutive: 2, lastRestartAt: 123, gaveUp: false } });
  assert.deepEqual(ws.readState(), { demo: { consecutive: 2, lastRestartAt: 123, gaveUp: false } });
});

test('文件损坏 → 当空对象，不抛', () => {
  fs.writeFileSync(process.env.TASK_QUEUE_WATCHDOG_STATE_PATH, '{ not json');
  assert.deepEqual(ws.readState(), {});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/lib.watchdog-state.test.cjs`
Expected: FAIL，`Cannot find module '../lib/watchdog-state.cjs'`

- [ ] **Step 3: 实现 `lib/watchdog-state.cjs`**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function statePath() {
  return process.env.TASK_QUEUE_WATCHDOG_STATE_PATH
    || path.join(os.homedir(), '.task-queue', 'watchdog-state.json');
}

/** 读状态；文件缺失或损坏均返回空对象。 */
function readState() {
  const p = statePath();
  if (!fs.existsSync(p)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

/** 落盘状态（best-effort 建目录）。 */
function writeState(state) {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
}

module.exports = { readState, writeState, statePath };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/lib.watchdog-state.test.cjs`
Expected: PASS（3 个 test）

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog-state.cjs tests/lib.watchdog-state.test.cjs
git commit -m "feat: lib/watchdog-state 看门狗退避状态读写

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 决策核心 decideProject + runPass

**Files:**
- Create: `commands/watchdog.cjs`（本任务先实现 `decideProject` / `runPass` / 常量；子动作分发在 Task 4 加）
- Test: `tests/commands.watchdog.test.cjs`

- [ ] **Step 1: 写失败测试 `tests/commands.watchdog.test.cjs`**

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wd = require('../commands/watchdog.cjs');
const { decideProject, runPass, STALE_MS, GRACE_MS, MAX_RESTARTS } = wd;

const NOW = 1_000_000_000_000;
const stale = (ms) => new Date(NOW - ms).toISOString();
const freshHb = { phase: 'idle', ts: stale(60 * 1000) };           // 1min 前，新鲜
const staleIdleHb = { phase: 'idle', ts: stale(STALE_MS + 1000) }; // >30min，idle
const staleExecHb = { phase: 'executing', ts: stale(STALE_MS + 1000) };
const emptyState = { consecutive: 0, lastRestartAt: null, gaveUp: false };

// ---- decideProject 纯函数 ----
test('hidden → ignore', () => {
  assert.equal(decideProject({ now: NOW, hidden: true, hb: staleIdleHb, paused: null, st: emptyState }).decision, 'ignore');
});
test('心跳新鲜 → reset', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: freshHb, paused: null, st: { consecutive: 2, lastRestartAt: NOW, gaveUp: true } }).decision, 'reset');
});
test('陈旧 idle 未暂停有 hb → restart', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st: emptyState }).decision, 'restart');
});
test('陈旧但 executing → skip', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleExecHb, paused: null, st: emptyState }).decision, 'skip');
});
test('陈旧但 paused → skip', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: '手动', st: emptyState }).decision, 'skip');
});
test('无 heartbeat → skip（不冷启）', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: null, paused: null, st: emptyState }).decision, 'skip');
});
test('grace 窗口内 → skip', () => {
  const st = { consecutive: 1, lastRestartAt: NOW - (GRACE_MS - 1000), gaveUp: false };
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st }).decision, 'skip');
});
test('grace 后仍陈旧 → restart', () => {
  const st = { consecutive: 1, lastRestartAt: NOW - (GRACE_MS + 1000), gaveUp: false };
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st }).decision, 'restart');
});
test('consecutive 达上限 → giveup', () => {
  const st = { consecutive: MAX_RESTARTS, lastRestartAt: NOW - (GRACE_MS + 1000), gaveUp: false };
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st }).decision, 'giveup');
});
test('已 gaveUp → skip', () => {
  const st = { consecutive: MAX_RESTARTS, lastRestartAt: NOW - (GRACE_MS + 1000), gaveUp: true };
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st }).decision, 'skip');
});

// ---- runPass 集成（注入 deps）----
function makeDeps(overrides = {}) {
  const tmuxCalls = [];
  const pushes = [];
  let savedState = overrides.state || {};
  return {
    tmuxCalls, pushes, getState: () => savedState,
    deps: {
      now: NOW,
      registryList: () => overrides.projects || [],
      readHeartbeat: (root) => (overrides.hb || {})[root] ?? null,
      readPaused: (root) => (overrides.paused || {})[root] ?? null,
      readState: () => savedState,
      writeState: (s) => { savedState = s; },
      execFileSyncImpl: (bin, args) => { tmuxCalls.push([bin, ...args].join(' ')); },
      launchHeadless: (root, slug, exec) => { exec('tmux', ['new-session', '-ds', `task-queue-loop-${slug}`]); return `task-queue-loop-${slug}`; },
      testPush: async (msg) => { pushes.push(msg); },
      log: () => {},
    },
  };
}

test('runPass：陈旧 idle 项目被重启，consecutive→1', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: false };
  const h = makeDeps({ projects: [proj], hb: { '/p/demo': staleIdleHb }, paused: {}, state: {} });
  await runPass(h.deps);
  assert.ok(h.tmuxCalls.some(c => c.includes('kill-session') && c.includes('task-queue-loop-demo')), '应先 kill-session');
  assert.ok(h.tmuxCalls.some(c => c.includes('new-session') && c.includes('task-queue-loop-demo')), '应 new-session 重启');
  assert.equal(h.getState().demo.consecutive, 1);
  assert.equal(typeof h.getState().demo.lastRestartAt, 'number');
});

test('runPass：consecutive 达上限 → 不重启、置 gaveUp、发桌面告警', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: false };
  const st = { demo: { consecutive: MAX_RESTARTS, lastRestartAt: NOW - (GRACE_MS + 1), gaveUp: false } };
  const h = makeDeps({ projects: [proj], hb: { '/p/demo': staleIdleHb }, paused: {}, state: st });
  await runPass(h.deps);
  assert.ok(!h.tmuxCalls.some(c => c.includes('new-session')), '放弃时不应再 new-session');
  assert.equal(h.getState().demo.gaveUp, true);
  assert.equal(h.pushes.length, 1, '应发一条桌面告警');
  assert.ok(h.pushes[0].includes('demo'), '告警含 slug');
});

test('runPass：心跳新鲜 → 复位退避状态', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: false };
  const st = { demo: { consecutive: 2, lastRestartAt: NOW, gaveUp: true } };
  const h = makeDeps({ projects: [proj], hb: { '/p/demo': freshHb }, paused: {}, state: st });
  await runPass(h.deps);
  assert.deepEqual(h.getState().demo, { consecutive: 0, lastRestartAt: null, gaveUp: false });
  assert.ok(!h.tmuxCalls.some(c => c.includes('new-session')));
});

test('runPass：hidden 项目完全忽略', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: true };
  const h = makeDeps({ projects: [proj], hb: { '/p/demo': staleIdleHb }, paused: {}, state: {} });
  await runPass(h.deps);
  assert.equal(h.tmuxCalls.length, 0);
  assert.deepEqual(h.getState(), {});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/commands.watchdog.test.cjs`
Expected: FAIL，`Cannot find module '../commands/watchdog.cjs'`

- [ ] **Step 3: 实现 `commands/watchdog.cjs`（本任务部分：常量 + decideProject + runPass）**

```javascript
'use strict';

const { execFileSync: realExecFileSync } = require('node:child_process');
const registry = require('../lib/registry.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { readPaused } = require('../lib/paused.cjs');
const { readState, writeState } = require('../lib/watchdog-state.cjs');
const { sessionName, launchHeadless } = require('../lib/launch-command.cjs');
const testPushCmd = require('./test-push.cjs');

const STALE_MS = 30 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;
const WATCHDOG_LABEL = 'com.taskqueue.watchdog';

const EMPTY = () => ({ consecutive: 0, lastRestartAt: null, gaveUp: false });

/**
 * 单项目决策（纯函数）。
 * @returns {{decision:'ignore'|'reset'|'skip'|'restart'|'giveup', reason?:string}}
 */
function decideProject({ now, hidden, hb, paused, st }) {
  if (hidden) return { decision: 'ignore' };
  const fresh = hb && hb.ts && (now - Date.parse(hb.ts)) <= STALE_MS;
  if (fresh) return { decision: 'reset' };
  if (paused) return { decision: 'skip', reason: 'paused' };
  if (!hb || !hb.ts) return { decision: 'skip', reason: 'never-ran' };
  if (hb.phase === 'executing') return { decision: 'skip', reason: 'executing' };
  if (st.gaveUp) return { decision: 'skip', reason: 'gave-up' };
  if (st.lastRestartAt && (now - st.lastRestartAt) < GRACE_MS) return { decision: 'skip', reason: 'grace' };
  if (st.consecutive >= MAX_RESTARTS) return { decision: 'giveup' };
  return { decision: 'restart' };
}

/**
 * 跑一遍扫描。所有副作用走注入 deps，便于单测。
 * @param {object} deps
 */
async function runPass(deps) {
  const {
    now = Date.now(),
    registryList = registry.list,
    readHeartbeat: readHb = readHeartbeat,
    readPaused: readPausedFn = readPaused,
    readState: readSt = readState,
    writeState: writeSt = writeState,
    execFileSyncImpl = realExecFileSync,
    launchHeadless: launch = launchHeadless,
    testPush = (msg) => testPushCmd(msg, ['--title', 'task-queue 看门狗']),
    log = (m) => process.stdout.write(m + '\n'),
  } = deps;

  const state = readSt();
  const projects = registryList();

  for (const entry of projects) {
    try {
      const st = state[entry.slug] || EMPTY();
      const hb = readHb(entry.root);
      const paused = readPausedFn(entry.root);
      const { decision, reason } = decideProject({ now, hidden: entry.hidden, hb, paused, st });

      if (decision === 'ignore') continue;
      if (decision === 'skip') { log(`[skip] ${entry.slug} (${reason})`); continue; }

      if (decision === 'reset') {
        if (state[entry.slug] && (st.consecutive || st.gaveUp || st.lastRestartAt)) {
          state[entry.slug] = EMPTY();
          writeSt(state);
        }
        continue;
      }

      if (decision === 'giveup') {
        state[entry.slug] = { ...st, gaveUp: true };
        writeSt(state);
        log(`[giveup] ${entry.slug} 连续 ${MAX_RESTARTS} 次重启失败，放弃`);
        await testPush(`看门狗：${entry.slug} 连续 ${MAX_RESTARTS} 次重启仍未恢复心跳，已放弃，请手动检查`);
        continue;
      }

      if (decision === 'restart') {
        const session = sessionName(entry.slug);
        try { execFileSyncImpl('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch (_) {}
        launch(entry.root, entry.slug, execFileSyncImpl);
        state[entry.slug] = { ...st, consecutive: st.consecutive + 1, lastRestartAt: now, gaveUp: false };
        writeSt(state);
        log(`[restart] ${entry.slug} 第 ${state[entry.slug].consecutive} 次重启`);
      }
    } catch (err) {
      log(`[error] ${entry.slug}: ${err.message}`);
    }
  }
}

module.exports = { decideProject, runPass, STALE_MS, GRACE_MS, MAX_RESTARTS, WATCHDOG_LABEL };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/commands.watchdog.test.cjs`
Expected: PASS（10 个 decideProject + 4 个 runPass = 14 个 test）

- [ ] **Step 5: Commit**

```bash
git add commands/watchdog.cjs tests/commands.watchdog.test.cjs
git commit -m "feat: watchdog 决策核心 decideProject + runPass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 子动作分发 + plist 渲染 + dispatcher 注册

**Files:**
- Modify: `commands/watchdog.cjs`（加 `renderPlist` + 默认 handler 分发）
- Modify: `tasks.cjs`（L18-24 `KNOWN_COMMANDS`、L27 `COMMANDS_NOT_REQUIRING_PROJECT_ROOT`）
- Test: `tests/commands.watchdog.test.cjs`（追加 `renderPlist` 用例）

- [ ] **Step 1: 追加失败测试到 `tests/commands.watchdog.test.cjs` 末尾**

```javascript
// ---- renderPlist ----
test('renderPlist 含 Label / StartInterval 60 / RunAtLoad / PATH / ProgramArguments', () => {
  const xml = wd.renderPlist({
    nodePath: '/opt/homebrew/bin/node',
    tasksCjs: '/Users/x/.claude/skills/task-queue/tasks.cjs',
    pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
    logPath: '/Users/x/.task-queue/watchdog.log',
  });
  assert.ok(xml.includes('<string>com.taskqueue.watchdog</string>'), '含 Label');
  assert.ok(xml.includes('<key>StartInterval</key>'));
  assert.ok(xml.includes('<integer>60</integer>'), 'StartInterval 60');
  assert.ok(xml.includes('<key>RunAtLoad</key>'));
  assert.ok(xml.includes('<true/>'));
  assert.ok(xml.includes('<string>/opt/homebrew/bin/node</string>'));
  assert.ok(xml.includes('<string>/Users/x/.claude/skills/task-queue/tasks.cjs</string>'));
  assert.ok(xml.includes('<string>watchdog</string>'));
  assert.ok(xml.includes('/opt/homebrew/bin:/usr/bin:/bin'), '含 PATH env');
  assert.ok(xml.includes('<string>/Users/x/.task-queue/watchdog.log</string>'), '含日志路径');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/commands.watchdog.test.cjs`
Expected: FAIL，`wd.renderPlist is not a function`

- [ ] **Step 3: 在 `commands/watchdog.cjs` 加 `renderPlist` + 子动作 handler**

在 `module.exports` 之前插入：
```javascript
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** which：返回绝对路径或 null。 */
function which(bin, execFileSyncImpl = realExecFileSync) {
  try {
    return execFileSyncImpl('/usr/bin/which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch (_) { return null; }
}

/** 渲染 launchd plist XML。 */
function renderPlist({ nodePath, tasksCjs, pathEnv, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${tasksCjs}</string>
    <string>watchdog</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
}

async function doInstall() {
  const nodePath = process.execPath;
  const tasksCjs = path.resolve(__dirname, '..', 'tasks.cjs');
  const tmux = which('tmux');
  const claude = which('claude');
  if (!tmux) throw new Error('PATH 中找不到 tmux，请先安装（brew install tmux）');
  if (!claude) throw new Error('PATH 中找不到 claude');
  const dirs = [path.dirname(nodePath), path.dirname(tmux), path.dirname(claude), '/usr/bin', '/bin'];
  const pathEnv = [...new Set(dirs)].join(':');
  const logPath = path.join(os.homedir(), '.task-queue', 'watchdog.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const xml = renderPlist({ nodePath, tasksCjs, pathEnv, logPath });
  const pl = plistPath();
  fs.mkdirSync(path.dirname(pl), { recursive: true });
  fs.writeFileSync(pl, xml);
  try { realExecFileSync('launchctl', ['unload', pl], { stdio: 'ignore' }); } catch (_) {}
  realExecFileSync('launchctl', ['load', '-w', pl], { stdio: 'inherit' });
  process.stdout.write(JSON.stringify({ ok: true, action: 'install', plist: pl, pathEnv }) + '\n');
}

async function doUninstall() {
  const pl = plistPath();
  try { realExecFileSync('launchctl', ['unload', pl], { stdio: 'ignore' }); } catch (_) {}
  try { fs.unlinkSync(pl); } catch (_) {}
  process.stdout.write(JSON.stringify({ ok: true, action: 'uninstall', plist: pl }) + '\n');
}

async function doStatus() {
  let loaded = false;
  try { realExecFileSync('launchctl', ['list', WATCHDOG_LABEL], { stdio: 'ignore' }); loaded = true; } catch (_) {}
  process.stdout.write(JSON.stringify({ ok: true, loaded, plist: plistPath(), state: readState() }, null, 2) + '\n');
}

/** dispatcher 入口：argv[3] 作为子动作（watchdog 不需 project-root）。 */
async function handler(subAction) {
  switch (subAction) {
    case 'install': return doInstall();
    case 'uninstall': return doUninstall();
    case 'status': return doStatus();
    case undefined:
    case 'run': return runPass({});
    default: throw new Error(`未知 watchdog 子动作: ${subAction}（可选: run/install/uninstall/status）`);
  }
}
```
把 `module.exports` 改为：
```javascript
module.exports = handler;
module.exports.decideProject = decideProject;
module.exports.runPass = runPass;
module.exports.renderPlist = renderPlist;
module.exports.STALE_MS = STALE_MS;
module.exports.GRACE_MS = GRACE_MS;
module.exports.MAX_RESTARTS = MAX_RESTARTS;
module.exports.WATCHDOG_LABEL = WATCHDOG_LABEL;
```
（注意：dispatcher `require('./commands/watchdog.cjs')` 取到的是函数 `handler`，调用 `handler(subAction, rest)`；测试里 `require` 后用 `wd.decideProject` 等取挂在函数上的属性。）

- [ ] **Step 4: 改 `tasks.cjs` 注册命令**

L18-24 `KNOWN_COMMANDS` 数组末尾（`set-checklist` 那一行后）加 `'watchdog'`：
```javascript
  'set-checklist', 'tick-checklist', 'untick-checklist', 'add-checklist', 'del-checklist',
  'watchdog',
];
```
L27 `COMMANDS_NOT_REQUIRING_PROJECT_ROOT` 加 `'watchdog'`：
```javascript
const COMMANDS_NOT_REQUIRING_PROJECT_ROOT = new Set(['detect', 'init-write', 'test-push', 'dashboard', 'watchdog']);
```

- [ ] **Step 5: 跑测试 + 冒烟确认**

Run: `node --test tests/commands.watchdog.test.cjs`
Expected: PASS（含新增 renderPlist 用例，共 15 个 test）

Run: `node tasks.cjs watchdog status`
Expected: 输出 JSON `{ ok: true, loaded: false, plist: ".../com.taskqueue.watchdog.plist", state: {} }`（尚未 install，loaded=false 正常）

- [ ] **Step 6: 全量测试回归**

Run: `node --test tests/`
Expected: 全绿（确认未破坏既有测试）

- [ ] **Step 7: Commit**

```bash
git add commands/watchdog.cjs tasks.cjs tests/commands.watchdog.test.cjs
git commit -m "feat: watchdog 子动作 install/uninstall/status + 注册 CLI 命令

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 真机部署与端到端验证（手动）

**Files:** 无（运行时操作）

- [ ] **Step 1: dry-run 跑一次扫描，确认对真实注册表行为正确**

Run: `node tasks.cjs watchdog run`
Expected: 对当前在线项目输出 `[skip]`/无动作；若 aggregates 此刻仍心跳停更 >30min 且非 executing/paused，应输出 `[restart] aggregates 第 1 次重启` 并起 tmux session。
验证：`tmux has-session -t task-queue-loop-aggregates && echo OK`

- [ ] **Step 2: 安装 launchd agent**

Run: `node tasks.cjs watchdog install`
Expected: 输出 `{ ok: true, action: 'install', plist: ... , pathEnv: ... }`，无 launchctl 报错。

- [ ] **Step 3: 确认 agent 已加载**

Run: `node tasks.cjs watchdog status`
Expected: `loaded: true`。
也可：`launchctl list | grep com.taskqueue.watchdog` 应有一行。

- [ ] **Step 4: 观察日志确认 60s 周期在跑**

Run（Monitor 或手动等 ~70s 后看）：`tail -n 20 ~/.task-queue/watchdog.log`
Expected: 能看到周期性扫描输出（`[skip]`/`[restart]` 等），证明 launchd 在按 StartInterval 拉起。

- [ ] **Step 5: 故障注入验证重启（可选但推荐）**

手动 kill 一个非-hidden 项目的 loop 会话模拟卡死，并把其心跳 ts 改老 >30min：
```bash
# 以 ditto 为例（请确认 ditto 此刻空闲、非 executing）
tmux kill-session -t task-queue-loop-ditto
```
等下一个看门狗周期（≤60s + 5min grace 逻辑：首次无 lastRestartAt 会立即重启），看日志出现 `[restart] ditto`，并 `tmux has-session -t task-queue-loop-ditto` 恢复。
验证后确认 ditto 心跳在数分钟内重新刷新（`cat <ditto-root>/.tasks/run/heartbeat.json` 的 ts 变新）。

- [ ] **Step 6: 收尾 commit（如有计划/文档微调）**

```bash
git add -A docs/
git commit -m "docs: 看门狗端到端验证记录

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自审记录

- **Spec 覆盖**：launchd 载体(Task4/5)、StartInterval60(Task4 plist)、30min阈值(Task3 STALE_MS)、executing/paused/never-ran 安全闸(Task3 decideProject)、仅非-hidden(Task3 ignore 分支)、3 次退避+放弃告警(Task3 giveup)、仅放弃告警(Task3 testPush 仅 giveup 分支)、5min grace(Task3 GRACE_MS)、60s 轮询(Task4 plist)、无头不 attach(Task1 launchHeadless)、PATH 坑(Task4 doInstall 拼 pathEnv)、错误隔离(Task3 try/catch per project)、子命令(Task4)、测试 11 项(Task3 全覆盖 + Task1 attach 项) — 全部有对应任务。
- **占位符**：无 TBD/TODO；每个代码步骤含完整代码。
- **类型一致**：`decideProject`/`runPass`/`renderPlist`/`launchHeadless`/`sessionName`/`readState`/`writeState` 跨任务签名一致；state 形状 `{consecutive, lastRestartAt(ms|null), gaveUp}` 全程统一；`lastRestartAt` 存毫秒数（Task3 写入 `now`，decideProject 用 `now - st.lastRestartAt` 比较）一致。
