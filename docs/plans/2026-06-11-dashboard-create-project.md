# Dashboard 创建项目并初始化 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Helm dashboard 上通过「＋ 接入项目」modal 向导完成项目接入（已有目录）或从零新建并初始化，与 Claude 会话里的 `/task-queue init` 完全等价。

**Architecture:** 把 `commands/detect.cjs` / `commands/init-write.cjs` 的核心逻辑抽到 `lib/detect-core.cjs` / `lib/init-core.cjs`（返回对象），新增 `lib/init-flow.cjs` 做路径校验/脚手架/编排，dashboard-server 暴露 `POST /api/init/detect` 和 `POST /api/init` 两个 API，前端在 `web/app.js` 加双 tab 两步向导 modal。

**Tech Stack:** Node.js (CommonJS, node:test), vanilla JS 前端（无框架），现有 `el()` / `postAction()` / chip-input 控件复用。

**Spec:** `docs/specs/2026-06-11-dashboard-create-project-design.md`

**测试命令:** `npm test`（= `node --test tests/*.test.cjs`）；单文件 `node --test tests/<file>.test.cjs`

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/detect-core.cjs` | Create | detect 主逻辑，`detectCore(root)` 返回对象 |
| `commands/detect.cjs` | Modify | 变薄壳：调 core → stdout JSON（CLI 行为不变） |
| `lib/init-core.cjs` | Create | init-write 主逻辑，`initCore(root, answers)` 返回对象 |
| `commands/init-write.cjs` | Modify | 变薄壳（CLI 行为不变） |
| `lib/git.cjs` | Modify | 加 `gitInitRepo` / `gitCommitPaths`（pathspec commit，不误带已暂存改动） |
| `lib/init-flow.cjs` | Create | 路径校验、inspectRoot、scaffold、runInit/registerOnly 编排 |
| `commands/dashboard-server.cjs` | Modify | 两个新 handler + 路由 |
| `web/app.js` | Modify | 「＋ 接入项目」按钮 + 两步向导 modal |
| `web/styles.css` | Modify | tabs / scope 块 / 模板预览样式 |
| `tests/lib.init-flow.test.cjs` | Create | init-flow 单测 |
| `tests/git.test.cjs` | Modify | gitCommitPaths / gitInitRepo 用例 |
| `tests/dashboard-server.init.test.cjs` | Create | 两个 API 集成测试 |
| `SKILL.md` / `README.md` | Modify | 面板能力文档同步 |

---

### Task 1: 抽取 lib/detect-core.cjs（行为不变重构）

**Files:**
- Create: `lib/detect-core.cjs`
- Modify: `commands/detect.cjs`（整文件替换为薄壳）
- 回归: `tests/commands.detect.test.cjs`

- [ ] **Step 1: 创建 lib/detect-core.cjs**

内容 = 现 `commands/detect.cjs` 的 `safeRead` / `safeReadJson` / `gitRun` / `detectPackage` / `detectCommitPattern` / `detectSameDayShare` 全部函数原样搬入（连同 JSDoc），require 路径 `../lib/module-dict.cjs` 改为 `./module-dict.cjs`，文件头与导出如下：

```js
// lib/detect-core.cjs — 静态分析项目结构，返回配置建议对象（detect 命令与 dashboard API 共用）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MODULE_DICT } = require('./module-dict.cjs');

// …… safeRead / safeReadJson / gitRun / detectPackage / detectCommitPattern / detectSameDayShare 原样搬入 ……

/**
 * 静态分析项目结构，返回配置建议对象（原 commands/detect.cjs 主逻辑）。
 * @param {string} projectRoot 项目根目录绝对路径
 * @returns {{ type: 'monorepo'|'single', packages: object[], commitPattern: object|null, sameDayShareVersion: string }}
 */
function detectCore(projectRoot) {
  const packages = [];

  const rootPkg = detectPackage(projectRoot, '.');
  if (rootPkg) packages.push(rootPkg);

  let entries;
  try {
    entries = fs.readdirSync(projectRoot);
  } catch (_) {
    entries = [];
  }
  for (const sub of entries) {
    if (sub.startsWith('.') || sub === 'node_modules') continue;
    const subAbs = path.join(projectRoot, sub);
    let stat;
    try { stat = fs.statSync(subAbs); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const pkg = detectPackage(projectRoot, sub);
    if (pkg) packages.push(pkg);
  }

  return {
    type: packages.length > 1 ? 'monorepo' : 'single',
    packages,
    commitPattern: detectCommitPattern(projectRoot),
    sameDayShareVersion: detectSameDayShare(projectRoot),
  };
}

module.exports = { detectCore };
```

- [ ] **Step 2: commands/detect.cjs 替换为薄壳**

```js
// commands/detect.cjs — 静态分析项目结构，输出 JSON 配置建议（核心逻辑在 lib/detect-core.cjs）
'use strict';

const { detectCore } = require('../lib/detect-core.cjs');

/**
 * detect 命令 CLI 入口。projectRoot 为空时默认 process.cwd()。
 * @param {string|undefined} projectRoot 项目根目录路径
 * @param {string[]} _args 剩余参数（暂未使用）
 * @returns {Promise<void>}
 */
module.exports = async function detect(projectRoot, _args) {
  if (!projectRoot) projectRoot = process.cwd();
  const result = detectCore(projectRoot);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
};
```

- [ ] **Step 3: 回归测试**

Run: `node --test tests/commands.detect.test.cjs`
Expected: 全部 PASS（stdout 输出格式逐字节不变）

- [ ] **Step 4: Commit**

```bash
git add lib/detect-core.cjs commands/detect.cjs
git commit -m "refactor: detect 主逻辑抽到 lib/detect-core.cjs(返回对象),CLI 变薄壳"
```

---

### Task 2: 抽取 lib/init-core.cjs（行为不变重构）

**Files:**
- Create: `lib/init-core.cjs`
- Modify: `commands/init-write.cjs`（整文件替换为薄壳）
- 回归: `tests/commands.init-write.test.cjs`

- [ ] **Step 1: 创建 lib/init-core.cjs**

内容 = 现 `commands/init-write.cjs` 的 `render` / `buildModuleDict` / `buildDefaultModule` 原样搬入 + 主逻辑改为返回对象。require 路径从 `../lib/x` 改 `./x`；模板路径 `path.join(__dirname, '..', 'templates', 'project.config.js')` 不变（lib/ 与 commands/ 同层级）：

```js
// lib/init-core.cjs — 将收集到的 answers 落盘到项目 .tasks/ 目录（init-write 命令与 dashboard API 共用）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createBlankWorkbook } = require('./workbook.cjs');
const { MODULE_DICT } = require('./module-dict.cjs');
const { add: registryAdd } = require('./registry.cjs');
const { Logger } = require('./logger.cjs');

// …… render / buildModuleDict / buildDefaultModule 三个函数原样搬入（连同 JSDoc）……

/**
 * 将配置 answers 渲染并落盘到 <root>/.tasks/（原 commands/init-write.cjs 主逻辑）。
 * 幂等：xlsx 已存在不覆盖、.gitignore 不重复追加、registry add 已存在即返回。
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {{ autoCommitScopes: string[], scopeMapping: Record<string, { dir: string, versionFile: string, changelogFile: string, buildCommand: string }>, candidateModules: Record<string, string[]>, commitTemplate: Record<string, string>, sameDayShareVersion: boolean }} answers
 * @returns {Promise<{ created: object, gitignoreAppended: boolean, registered: { slug: string, root: string }|null }>}
 */
async function initCore(projectRoot, answers) {
  const tasksDir = path.join(projectRoot, '.tasks');
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(path.join(tasksDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(tasksDir, 'run'), { recursive: true });

  // …… 以下与原 init-write 主体相同：构造 scopes/buildCommands/versionFiles/changelogFiles、
  //     buildModuleDict、渲染模板、写 project.config.js、createBlankWorkbook、追加 .gitignore、
  //     best-effort registryAdd ……（原样搬入，去掉 JSON.parse 与 process.stdout.write）

  return {
    created: {
      configFile: path.join('.tasks', 'project.config.js'),
      xlsxFile:   path.join('.tasks', 'tasks.xlsx'),
      logsDir:    path.join('.tasks', 'logs'),
    },
    gitignoreAppended: appended,
    registered: registered ? { slug: registered.slug, root: registered.root } : null,
  };
}

module.exports = { initCore };
```

- [ ] **Step 2: commands/init-write.cjs 替换为薄壳**

```js
// commands/init-write.cjs — 将 Claude 收集到的 answers 落盘（核心逻辑在 lib/init-core.cjs）
'use strict';

const { initCore } = require('../lib/init-core.cjs');

/**
 * init-write 命令 CLI 入口：解析 answers JSON → initCore → stdout 输出结果 JSON。
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} args args[0] 为 answers JSON 字符串
 * @returns {Promise<void>}
 */
module.exports = async function initWrite(projectRoot, args) {
  const answersJsonRaw = args[0];
  if (!answersJsonRaw) throw new Error('init-write 需要 <answers-json> 参数');

  let answers;
  try {
    answers = JSON.parse(answersJsonRaw);
  } catch (e) {
    throw new Error(`answers-json 解析失败: ${e.message}`);
  }

  const result = await initCore(projectRoot, answers);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
};
```

- [ ] **Step 3: 回归测试**

Run: `node --test tests/commands.init-write.test.cjs`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add lib/init-core.cjs commands/init-write.cjs
git commit -m "refactor: init-write 主逻辑抽到 lib/init-core.cjs(返回对象),CLI 变薄壳"
```

---

### Task 3: lib/git.cjs 增加 gitInitRepo / gitCommitPaths（TDD）

`gitCommit` 会把用户已暂存的其它改动一起 commit 进去——dashboard init 必须用 pathspec commit 只提交指定文件。

**Files:**
- Modify: `lib/git.cjs:113`（module.exports 行前加两个函数）
- Test: `tests/git.test.cjs`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `tests/git.test.cjs` 追加（沿用该文件现有 tmp 仓库搭建方式；若文件用工厂则复用之）：

```js
test('gitCommitPaths 只提交指定文件,不带上其它已暂存改动', async () => {
  const proj = await setupGitProject(); // 该测试文件现有的 tmp git 仓库工厂
  fs.writeFileSync(path.join(proj, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(proj, 'b.txt'), 'b\n');
  execFileSync('git', ['add', 'a.txt', 'b.txt'], { cwd: proj });

  gitCommitPaths(proj, 'only a', ['a.txt']);

  const lastFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'],
    { cwd: proj, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(lastFiles, ['a.txt']);
  // b.txt 仍在暂存区未被提交
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'],
    { cwd: proj, encoding: 'utf8' }).trim();
  assert.equal(staged, 'b.txt');
});

test('gitInitRepo 在空目录初始化 git 仓库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-init-test-'));
  gitInitRepo(dir);
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/git.test.cjs`
Expected: FAIL，`gitCommitPaths is not a function`

- [ ] **Step 3: 实现**

在 `lib/git.cjs` 的 `gitCommit` 之后加：

```js
/**
 * 初始化 git 仓库（`git init -q`），已是仓库时 git 自身幂等。
 * @param {string} cwd - 目标目录
 */
function gitInitRepo(cwd) {
  run(cwd, ['init', '-q']);
}

/**
 * 创建只包含指定 pathspec 的 commit（`git commit -m msg -- files`），
 * 不会带上暂存区里其它文件的改动。文件需已 gitAdd（未追踪文件 pathspec 不识别）。
 * @param {string} cwd - git 仓库路径
 * @param {string} message - commit 信息
 * @param {string[]} files - 要提交的文件路径列表
 */
function gitCommitPaths(cwd, message, files) {
  run(cwd, ['commit', '-m', message, '--', ...files]);
}
```

并把 `gitInitRepo, gitCommitPaths` 加入 `module.exports`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/git.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/git.cjs tests/git.test.cjs
git commit -m "feat: git 封装加 gitInitRepo/gitCommitPaths(pathspec commit 防误带暂存改动)"
```

---

### Task 4: lib/init-flow.cjs — 路径校验与探测（TDD）

**Files:**
- Create: `lib/init-flow.cjs`
- Test: Create `tests/lib.init-flow.test.cjs`

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-flow-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const {
  resolveInitPath, validateAttachRoot, validateCreateTarget, inspectRoot,
} = require('../lib/init-flow.cjs');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

test('resolveInitPath 展开 ~ 为 home 目录', () => {
  assert.equal(resolveInitPath('~/foo'), path.join(os.homedir(), 'foo'));
});

test('resolveInitPath 拒绝相对路径', () => {
  assert.throws(() => resolveInitPath('foo/bar'), /绝对路径/);
});

test('resolveInitPath 拒绝根目录与 home 本身', () => {
  assert.throws(() => resolveInitPath('/'), /根目录/);
  assert.throws(() => resolveInitPath(os.homedir()), /home/);
  assert.throws(() => resolveInitPath('~'), /home/);
});

test('resolveInitPath 规范化 .. 段后再校验', () => {
  // 借 .. 绕回 home 也要被拒
  assert.throws(() => resolveInitPath(path.join(os.homedir(), 'x', '..')), /home/);
});

test('validateAttachRoot: 目录存在通过,不存在抛错', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'attach-'));
  validateAttachRoot(dir); // 不抛
  assert.throws(() => validateAttachRoot(path.join(tmpDir, 'nope')), /不存在/);
});

test('validateCreateTarget: 目标已存在抛错,父目录不存在抛错', () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'parent-'));
  validateCreateTarget(path.join(parent, 'new-proj')); // 不抛
  assert.throws(() => validateCreateTarget(parent), /已存在/);
  assert.throws(() => validateCreateTarget(path.join(tmpDir, 'ghost', 'new-proj')), /父目录不存在/);
});

test('inspectRoot 报告 isGitRepo 与 alreadyInitialized', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'inspect-'));
  assert.deepEqual(inspectRoot(dir), { isGitRepo: false, alreadyInitialized: false });

  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.tasks'));
  fs.writeFileSync(path.join(dir, '.tasks', 'project.config.js'), 'module.exports = {};\n');
  assert.deepEqual(inspectRoot(dir), { isGitRepo: true, alreadyInitialized: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/lib.init-flow.test.cjs`
Expected: FAIL，`Cannot find module '../lib/init-flow.cjs'`

- [ ] **Step 3: 实现 lib/init-flow.cjs（本任务只到 inspectRoot）**

```js
// lib/init-flow.cjs — dashboard「接入项目」编排:路径校验/探测/脚手架/init+commit
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { initCore } = require('./init-core.cjs');
const { add: registryAdd } = require('./registry.cjs');
const { gitAdd, gitCommitPaths, gitInitRepo } = require('./git.cjs');

/** init 完成后 .gitignore 的提交信息（与 CLI init 流程同款） */
const INIT_COMMIT_MESSAGE = 'task-queue: 接入任务队列（ignore .tasks/）';

/**
 * 规范化用户输入路径：展开 ~、要求绝对路径、resolve 掉 ../，
 * 并拒绝文件系统根目录和 home 目录本身这类危险目标。
 * @param {string} raw 用户输入
 * @returns {string} 规范化后的绝对路径
 */
function resolveInitPath(raw) {
  let p = String(raw || '').trim();
  if (!p) throw new Error('路径不能为空');
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new Error(`需要绝对路径: ${p}`);
  p = path.resolve(p);
  if (p === path.parse(p).root) throw new Error('不允许使用文件系统根目录');
  if (p === os.homedir()) throw new Error('不允许使用 home 目录本身');
  return p;
}

/**
 * attach 模式校验：root 必须是已存在的目录。
 * @param {string} root 规范化绝对路径
 */
function validateAttachRoot(root) {
  let stat;
  try { stat = fs.statSync(root); } catch (_) { throw new Error(`目录不存在: ${root}`); }
  if (!stat.isDirectory()) throw new Error(`不是目录: ${root}`);
}

/**
 * create 模式校验：root 必须不存在，父目录必须存在。
 * @param {string} root 规范化绝对路径
 */
function validateCreateTarget(root) {
  if (fs.existsSync(root)) throw new Error(`目标已存在: ${root}（请改用「接入已有」）`);
  const parent = path.dirname(root);
  let stat;
  try { stat = fs.statSync(parent); } catch (_) { throw new Error(`父目录不存在: ${parent}`); }
  if (!stat.isDirectory()) throw new Error(`父目录不是目录: ${parent}`);
}

/**
 * 探测 root 的 git / 接入状态。
 * @param {string} root
 * @returns {{ isGitRepo: boolean, alreadyInitialized: boolean }}
 */
function inspectRoot(root) {
  return {
    isGitRepo: fs.existsSync(path.join(root, '.git')),
    alreadyInitialized: fs.existsSync(path.join(root, '.tasks', 'project.config.js')),
  };
}

module.exports = {
  INIT_COMMIT_MESSAGE,
  resolveInitPath, validateAttachRoot, validateCreateTarget, inspectRoot,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/lib.init-flow.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/init-flow.cjs tests/lib.init-flow.test.cjs
git commit -m "feat: init-flow 路径校验与探测(resolve/attach/create/inspect)"
```

---

### Task 5: lib/init-flow.cjs — scaffoldProject + runInit + registerOnly（TDD）

**Files:**
- Modify: `lib/init-flow.cjs`
- Test: `tests/lib.init-flow.test.cjs`（追加用例）

测试公共物料——文件顶部加一个标准 answers 工厂：

```js
function makeAnswers(scope = 'main') {
  return {
    autoCommitScopes: [],
    scopeMapping: { [scope]: { dir: '.', versionFile: 'package.json', changelogFile: '', buildCommand: '' } },
    candidateModules: { [scope]: ['全局'] },
    commitTemplate: { [scope]: `T#0000 ${scope}## {version}\n\n【{module}】{desc}；` },
    sameDayShareVersion: true,
  };
}

function gitConfigTestUser(dir) {
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}
```

- [ ] **Step 1: 写失败测试（追加）**

```js
const { scaffoldProject, runInit, registerOnly } = require('../lib/init-flow.cjs');

test('scaffoldProject: mkdir + git init + 最小 package.json,不产生 commit', () => {
  const root = path.join(fs.mkdtempSync(path.join(tmpDir, 'scaf-')), 'fresh-proj');
  scaffoldProject(root);
  assert.ok(fs.existsSync(path.join(root, '.git')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'fresh-proj');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.private, true);
  // 尚无任何 commit
  assert.throws(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' }));
});

test('runInit attach: 落盘 .tasks + 注册 + commit .gitignore', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-attach-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  gitConfigTestUser(root);

  const result = await runInit({ mode: 'attach', root, gitInit: false, answers: makeAnswers() });

  assert.ok(result.slug);
  assert.equal(result.committed, true);
  assert.equal(result.warning, null);
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'project.config.js')));
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'tasks.xlsx')));
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.tasks\/$/m);

  const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(subject, 'task-queue: 接入任务队列（ignore .tasks/）');
  const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files, ['.gitignore']);
});

test('runInit attach: commit 不带上用户已暂存的其它改动', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-staged-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  gitConfigTestUser(root);
  fs.writeFileSync(path.join(root, 'wip.txt'), 'in progress\n');
  execFileSync('git', ['add', 'wip.txt'], { cwd: root });

  await runInit({ mode: 'attach', root, gitInit: false, answers: makeAnswers() });

  const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files, ['.gitignore']);
});

test('runInit attach + gitInit: 非 git 目录先 init 再走全流程', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-gitinit-'));
  const result = await runInit({ mode: 'attach', root, gitInit: true, answers: makeAnswers() });
  // 注意:新 init 的仓库继承全局 git config;CI/本机有 user.name 时 commit 成功
  assert.ok(fs.existsSync(path.join(root, '.git')));
  assert.ok(result.slug);
});

test('runInit attach 非 git 且不 gitInit: 跳过 commit 并给 warning', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-nogit-'));
  const result = await runInit({ mode: 'attach', root, gitInit: false, answers: makeAnswers() });
  assert.equal(result.committed, false);
  assert.match(result.warning, /不是 git 仓库/);
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'project.config.js'))); // 落盘不受影响
});

test('runInit create: 脚手架 + init + 首 commit 含 package.json 和 .gitignore', async () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'run-create-'));
  const root = path.join(parent, 'brand-new');
  const result = await runInit({ mode: 'create', root, gitInit: false, answers: makeAnswers() });
  gitConfigTestUser(root); // scaffold 后已 init;此行仅为后续断言不受签名配置影响,可省

  assert.ok(result.slug);
  assert.ok(fs.existsSync(path.join(root, 'package.json')));
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'tasks.xlsx')));
  const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(files, ['.gitignore', 'package.json']);
});

test('runInit: git commit 失败时不回滚,返回 warning', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'run-fail-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  // 注入必败 hook:pre-commit 直接 exit 1
  const hookDir = path.join(root, '.git', 'hooks');
  fs.writeFileSync(path.join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const result = await runInit({ mode: 'attach', root, gitInit: false, answers: makeAnswers() });
  assert.equal(result.committed, false);
  assert.match(result.warning, /commit 失败/);
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'project.config.js'))); // 不回滚
  assert.ok(result.slug); // registry 注册成功
});

test('registerOnly: 只注册不动配置', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'reg-only-'));
  fs.mkdirSync(path.join(root, '.tasks'));
  fs.writeFileSync(path.join(root, '.tasks', 'project.config.js'), 'module.exports = { marker: 1 };\n');

  const entry = registerOnly(root);
  assert.ok(entry.slug);
  // 配置原样未动
  assert.match(fs.readFileSync(path.join(root, '.tasks', 'project.config.js'), 'utf8'), /marker: 1/);
});
```

注：create 模式 commit 依赖本机全局 git user 配置；与 `createTmpGitProjectFactory` 同假设（本仓测试环境已具备）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/lib.init-flow.test.cjs`
Expected: 新用例 FAIL，`scaffoldProject is not a function`

- [ ] **Step 3: 实现（lib/init-flow.cjs 追加）**

```js
/**
 * create 模式脚手架：mkdir -p + git init + 最小 package.json。
 * 写 package.json 保证 done 流程的版本号 bump 可用（versionFiles 指向它）。
 * 不产生 commit——首 commit 由 runInit 统一做（与 .gitignore 一起）。
 * @param {string} root 目标路径（已通过 validateCreateTarget）
 */
function scaffoldProject(root) {
  fs.mkdirSync(root, { recursive: true });
  gitInitRepo(root);
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: path.basename(root),
      version: '0.1.0',
      private: true,
    }, null, 2) + '\n');
  }
}

/**
 * dashboard init 全链路编排：
 *   create → 校验 + 脚手架；attach → 校验 (+ 可选 git init)
 *   → initCore 落盘 .tasks/ + 注册 registry
 *   → git commit（显式 pathspec,只含 .gitignore / create 模式加 package.json）
 *
 * git 相关失败不回滚：落盘与注册成功即算接入成功，commit 失败转 warning。
 *
 * @param {{ mode: 'attach'|'create', root: string, gitInit?: boolean, answers: object }} opts
 * @returns {Promise<{ slug: string, root: string, committed: boolean, warning: string|null }>}
 */
async function runInit({ mode, root, gitInit = false, answers }) {
  if (mode === 'create') {
    validateCreateTarget(root);
    scaffoldProject(root);
  } else {
    validateAttachRoot(root);
    if (gitInit && !inspectRoot(root).isGitRepo) gitInitRepo(root);
  }

  const initResult = await initCore(root, answers);
  // initCore 内 registryAdd 是 best-effort;失败时这里显式重试,再失败则抛出（接入失败）
  const entry = initResult.registered || registryAdd(root);

  let committed = false;
  let warning = null;
  const filesToCommit = [];
  if (initResult.gitignoreAppended) filesToCommit.push('.gitignore');
  if (mode === 'create') filesToCommit.push('package.json');

  if (!inspectRoot(root).isGitRepo) {
    warning = '目录不是 git 仓库，已跳过 .gitignore commit；任务执行的 commit 流程将不可用';
  } else if (filesToCommit.length > 0) {
    try {
      gitAdd(root, filesToCommit);
      gitCommitPaths(root, INIT_COMMIT_MESSAGE, filesToCommit);
      committed = true;
    } catch (e) {
      warning = `init 已完成，但 git commit 失败: ${e.message}`;
    }
  }

  return { slug: entry.slug, root, committed, warning };
}

/**
 * 仅注册到面板（项目已有 .tasks/ 配置但 registry 丢失的兜底），不动任何文件。
 * @param {string} root
 * @returns {{ slug: string, root: string }}
 */
function registerOnly(root) {
  validateAttachRoot(root);
  return registryAdd(root);
}
```

`module.exports` 追加 `scaffoldProject, runInit, registerOnly`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/lib.init-flow.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/init-flow.cjs tests/lib.init-flow.test.cjs
git commit -m "feat: init-flow 脚手架与 runInit/registerOnly 编排(commit 失败不回滚)"
```

---

### Task 6: dashboard-server POST /api/init/detect（TDD 集成）

**Files:**
- Modify: `commands/dashboard-server.cjs`
- Test: Create `tests/dashboard-server.init.test.cjs`

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-init-test-'));
process.env.TASK_QUEUE_REGISTRY_PATH = path.join(tmpDir, 'registry.json');

const { startServer } = require('../commands/dashboard-server.cjs');

let inst;
beforeEach(() => { try { fs.unlinkSync(process.env.TASK_QUEUE_REGISTRY_PATH); } catch (_) {} });
after(async () => {
  if (inst) await inst.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TASK_QUEUE_REGISTRY_PATH;
});

async function srv() {
  if (!inst) inst = await startServer({ port: 0 });
  return `http://127.0.0.1:${inst.port}`;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('POST /api/init/detect attach: 返回 detect 结果与状态位', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'det-'));
  execFileSync('git', ['init', '-q'], { cwd: proj });
  fs.writeFileSync(path.join(proj, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.2.3', scripts: { build: 'true' } }));

  const r = await post(`${await srv()}/api/init/detect`, { root: proj, mode: 'attach' });
  assert.equal(r.status, 200);
  assert.equal(r.body.root, proj);
  assert.equal(r.body.isGitRepo, true);
  assert.equal(r.body.alreadyInitialized, false);
  assert.equal(r.body.detect.packages[0].version, '1.2.3');
});

test('POST /api/init/detect attach: 已接入项目报 alreadyInitialized', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'det-inited-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  fs.writeFileSync(path.join(proj, '.tasks', 'project.config.js'), 'module.exports = {};\n');

  const r = await post(`${await srv()}/api/init/detect`, { root: proj, mode: 'attach' });
  assert.equal(r.status, 200);
  assert.equal(r.body.alreadyInitialized, true);
});

test('POST /api/init/detect attach: 目录不存在 → 400', async () => {
  const r = await post(`${await srv()}/api/init/detect`,
    { root: path.join(tmpDir, 'ghost'), mode: 'attach' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /不存在/);
});

test('POST /api/init/detect create: 目标不存在时返回空 detect', async () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'det-create-'));
  const r = await post(`${await srv()}/api/init/detect`,
    { root: path.join(parent, 'newp'), mode: 'create' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.detect.packages, []);
  assert.equal(r.body.isGitRepo, false);
});

test('POST /api/init/detect create: 目标已存在 → 400', async () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'det-exists-'));
  const r = await post(`${await srv()}/api/init/detect`, { root: parent, mode: 'create' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /已存在/);
});

test('POST /api/init/detect: 缺 root 或非法 mode → 400', async () => {
  const r1 = await post(`${await srv()}/api/init/detect`, { mode: 'attach' });
  assert.equal(r1.status, 400);
  const r2 = await post(`${await srv()}/api/init/detect`, { root: '/tmp/x', mode: 'bogus' });
  assert.equal(r2.status, 400);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/dashboard-server.init.test.cjs`
Expected: FAIL（404 `API not implemented yet`）

- [ ] **Step 3: 实现 handler 与路由**

`commands/dashboard-server.cjs` 顶部 require 区（`launch-command.cjs` 那行之后）追加：

```js
const { detectCore } = require('../lib/detect-core.cjs');
const {
  resolveInitPath, validateAttachRoot, validateCreateTarget, inspectRoot,
  runInit, registerOnly,
} = require('../lib/init-flow.cjs');
```

（`runInit, registerOnly` 供 Task 7 使用，一次引入。）

handler（放在 `handleCleanupMissing` 定义之后）：

```js
/**
 * 处理 POST /api/init/detect — 「接入项目」向导第一步：路径校验 + 结构探测。
 * body: { root, mode: 'attach'|'create' }
 * attach: 目录必须存在,返回完整 detect 结果;
 * create: 目标必须不存在且父目录存在,返回空 detect(目录还没建,向导用空项目默认值)。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleInitDetect(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  if (!body || !body.root || !['attach', 'create'].includes(body.mode)) {
    return sendJson(res, 400, { error: 'root 和 mode(attach|create) 必填' });
  }
  try {
    const root = resolveInitPath(body.root);
    if (body.mode === 'create') {
      validateCreateTarget(root);
      return sendJson(res, 200, {
        root,
        isGitRepo: false,
        alreadyInitialized: false,
        detect: { type: 'single', packages: [], commitPattern: null, sameDayShareVersion: 'unknown' },
      });
    }
    validateAttachRoot(root);
    const { isGitRepo, alreadyInitialized } = inspectRoot(root);
    return sendJson(res, 200, { root, isGitRepo, alreadyInitialized, detect: detectCore(root) });
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message) });
  }
}
```

路由：`handle()` 里 `/api/cleanup-missing` 块之后加：

```js
  if (pathname === '/api/init/detect' && req.method === 'POST') {
    handleInitDetect(req, res).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/dashboard-server.init.test.cjs`
Expected: 全部 PASS（Task 7 的用例还没写，本文件当前用例全绿）

- [ ] **Step 5: Commit**

```bash
git add commands/dashboard-server.cjs tests/dashboard-server.init.test.cjs
git commit -m "feat: dashboard API POST /api/init/detect(路径校验+结构探测)"
```

---

### Task 7: dashboard-server POST /api/init（TDD 集成）

**Files:**
- Modify: `commands/dashboard-server.cjs`
- Test: `tests/dashboard-server.init.test.cjs`（追加）

- [ ] **Step 1: 写失败测试（追加）**

测试文件顶部追加 answers 工厂（与 Task 5 相同形态）：

```js
function makeAnswers(scope = 'main') {
  return {
    autoCommitScopes: [],
    scopeMapping: { [scope]: { dir: '.', versionFile: 'package.json', changelogFile: '', buildCommand: '' } },
    candidateModules: { [scope]: ['全局'] },
    commitTemplate: { [scope]: `T#0000 ${scope}## {version}\n\n【{module}】{desc}；` },
    sameDayShareVersion: true,
  };
}
```

用例：

```js
test('POST /api/init attach: 全链路落盘+注册+commit,项目出现在 /api/projects', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'init-attach-'));
  execFileSync('git', ['init', '-q'], { cwd: proj });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: proj });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: proj });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: proj });

  const r = await post(`${await srv()}/api/init`,
    { mode: 'attach', root: proj, answers: makeAnswers() });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.committed, true);
  assert.ok(fs.existsSync(path.join(proj, '.tasks', 'tasks.xlsx')));

  const list = await fetch(`${await srv()}/api/projects`).then(x => x.json());
  assert.ok(list.projects.some(p => p.slug === r.body.slug));
});

test('POST /api/init create: 脚手架全链路', async () => {
  const parent = fs.mkdtempSync(path.join(tmpDir, 'init-create-'));
  const root = path.join(parent, 'newborn');
  const r = await post(`${await srv()}/api/init`,
    { mode: 'create', root, answers: makeAnswers() });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(root, 'package.json')));
  assert.ok(fs.existsSync(path.join(root, '.tasks', 'project.config.js')));
});

test('POST /api/init register: 仅注册不动配置', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'init-reg-'));
  fs.mkdirSync(path.join(proj, '.tasks'));
  fs.writeFileSync(path.join(proj, '.tasks', 'project.config.js'), 'module.exports = { marker: 7 };\n');

  const r = await post(`${await srv()}/api/init`, { mode: 'register', root: proj });
  assert.equal(r.status, 200);
  assert.ok(r.body.slug);
  assert.match(fs.readFileSync(path.join(proj, '.tasks', 'project.config.js'), 'utf8'), /marker: 7/);
});

test('POST /api/init: answers 缺失或不完整 → 400', async () => {
  const proj = fs.mkdtempSync(path.join(tmpDir, 'init-bad-'));
  const r1 = await post(`${await srv()}/api/init`, { mode: 'attach', root: proj });
  assert.equal(r1.status, 400);
  const r2 = await post(`${await srv()}/api/init`,
    { mode: 'attach', root: proj, answers: { scopeMapping: {} } });
  assert.equal(r2.status, 400);
});

test('POST /api/init: 路径越界 → 400', async () => {
  const r = await post(`${await srv()}/api/init`,
    { mode: 'attach', root: '/', answers: makeAnswers() });
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/dashboard-server.init.test.cjs`
Expected: 新用例 FAIL（404）

- [ ] **Step 3: 实现 handler 与路由**

handler（`handleInitDetect` 之后）：

```js
/**
 * 处理 POST /api/init — 「接入项目」向导提交。
 * body: { mode: 'attach'|'create'|'register', root, gitInit?, answers? }
 * register 模式只 registryAdd(项目已有 .tasks 配置但 registry 丢失的兜底);
 * attach/create 走 runInit 全链路。git commit 失败不回滚,转 warning 字段。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleInit(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  if (!body || !body.root || !['attach', 'create', 'register'].includes(body.mode)) {
    return sendJson(res, 400, { error: 'root 和 mode(attach|create|register) 必填' });
  }
  try {
    const root = resolveInitPath(body.root);
    if (body.mode === 'register') {
      const entry = registerOnly(root);
      return sendJson(res, 200, { ok: true, slug: entry.slug, root, committed: false, warning: null });
    }
    const answers = body.answers;
    if (!answers || typeof answers !== 'object'
        || !answers.scopeMapping || Object.keys(answers.scopeMapping).length === 0
        || !answers.commitTemplate) {
      return sendJson(res, 400, { error: 'answers 缺失或不完整（需要 scopeMapping / commitTemplate）' });
    }
    const result = await runInit({
      mode: body.mode, root, gitInit: body.gitInit === true, answers,
    });
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message) });
  }
}
```

路由（`/api/init/detect` 块之后——注意放在它后面避免前缀遮蔽无关紧要，两条是精确匹配）：

```js
  if (pathname === '/api/init' && req.method === 'POST') {
    handleInit(req, res).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/dashboard-server.init.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add commands/dashboard-server.cjs tests/dashboard-server.init.test.cjs
git commit -m "feat: dashboard API POST /api/init(attach/create/register 三模式)"
```

---

### Task 8: 前端 — 「＋ 接入项目」按钮 + 向导第一步（双 tab 路径选择）

前端无自动化测试基建（现有 web 测试只测纯函数），本任务以人工冒烟验证收尾。

**Files:**
- Modify: `web/app.js`（`renderProjects` 末尾 + 新增向导函数块）
- Modify: `web/styles.css`（向导样式）

- [ ] **Step 1: state 与入口按钮**

`web/app.js` 顶部 `state` 对象加一个字段（与现有 `addModal` 等并列）：

```js
  initModal: null,
```

`renderProjects()`（`web/app.js:674`）函数末尾、hidden section 之后追加：

```js
  list.appendChild(el('button', {
    className: 'btn add-project-btn',
    onclick: openInitModal,
  }, '＋ 接入项目'));
```

- [ ] **Step 2: 向导骨架 — 打开/关闭/第一步**

在 `collectKnownTags` / `buildTagInput` 附近新增一个「接入项目向导」函数块：

```js
/* ---------- 接入项目向导 ---------- */

const INIT_PARENT_KEY = 'task-queue-init-parent-dir';

function openInitModal() {
  state.initModal = {
    step: 1,
    tab: 'attach',                 // 'attach' | 'create'
    attachPath: '',
    parentDir: localStorage.getItem(INIT_PARENT_KEY) || '',
    name: '',
    root: '',                      // detect 后服务端规范化的绝对路径
    isGitRepo: false,
    alreadyInitialized: false,
    gitInit: false,
    form: null,                    // 第二步表单 state(buildFormFromDetect 产出)
    loading: false,
    submitting: false,
    error: '',
  };
  renderInitModal();
}

function closeInitModal() {
  state.initModal = null;
  renderInitModal();
}

/**
 * 向导第一步「下一步」:调 /api/init/detect 校验路径并探测,
 * 成功 → 进第二步(已接入项目则停在第一步显示「仅注册」入口)。
 */
async function initModalNext() {
  const m = state.initModal;
  if (!m || m.loading) return;
  let rawRoot;
  if (m.tab === 'attach') {
    if (!m.attachPath.trim()) { m.error = '路径不能为空'; renderInitModal(); return; }
    rawRoot = m.attachPath.trim();
  } else {
    if (!m.parentDir.trim()) { m.error = '父目录不能为空'; renderInitModal(); return; }
    if (!m.name.trim()) { m.error = '项目名不能为空'; renderInitModal(); return; }
    rawRoot = m.parentDir.trim().replace(/\/+$/, '') + '/' + m.name.trim();
  }
  m.loading = true; m.error = ''; renderInitModal();
  const r = await postAction('/api/init/detect', { root: rawRoot, mode: m.tab });
  m.loading = false;
  if (!r.ok) { m.error = r.body?.error || `失败 (${r.status})`; renderInitModal(); return; }
  m.root = r.body.root;
  m.isGitRepo = r.body.isGitRepo;
  m.alreadyInitialized = r.body.alreadyInitialized;
  m.gitInit = !r.body.isGitRepo; // 非 git 仓库默认勾选「同时 git init」
  if (!m.alreadyInitialized) {
    m.form = buildFormFromDetect(r.body.detect);
    m.step = 2;
  }
  renderInitModal();
}

/** 已接入项目的兜底:仅注册到面板,不动配置。 */
async function submitRegisterOnly() {
  const m = state.initModal;
  if (!m) return;
  const r = await postAction('/api/init', { mode: 'register', root: m.root });
  if (r.ok) {
    closeInitModal();
    await refreshProjects();
    selectProject(r.body.slug);
  } else {
    m.error = r.body?.error || `失败 (${r.status})`;
    renderInitModal();
  }
}
```

- [ ] **Step 3: renderInitModal 第一步 DOM**

```js
function renderInitModal() {
  const old = document.getElementById('init-modal');
  if (old) old.remove();
  const m = state.initModal;
  if (!m) return;

  const backdrop = el('div', {
    id: 'init-modal', className: 'modal-backdrop',
    onclick: e => { if (e.target === backdrop) closeInitModal(); },
  });
  const modal = el('div', { className: 'modal init-modal' });
  modal.appendChild(el('div', { className: 'modal-title' },
    m.step === 1 ? '接入项目 — 选择路径' : `接入项目 — 配置（${m.root}）`));

  if (m.step === 1) {
    renderInitStep1(modal, m);
  } else {
    renderInitStep2(modal, m);
  }

  if (m.error) modal.appendChild(el('div', { className: 'modal-error' }, m.error));
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

function renderInitStep1(modal, m) {
  // 双 tab
  const tabs = el('div', { className: 'init-tabs' },
    el('button', {
      className: 'init-tab' + (m.tab === 'attach' ? ' active' : ''),
      onclick: () => { m.tab = 'attach'; m.error = ''; m.alreadyInitialized = false; renderInitModal(); },
    }, '接入已有'),
    el('button', {
      className: 'init-tab' + (m.tab === 'create' ? ' active' : ''),
      onclick: () => { m.tab = 'create'; m.error = ''; m.alreadyInitialized = false; renderInitModal(); },
    }, '从零新建'),
  );
  modal.appendChild(tabs);

  if (m.tab === 'attach') {
    modal.appendChild(el('label', { className: 'modal-label' }, '项目路径（绝对路径，支持 ~）',
      el('input', {
        className: 'modal-input', type: 'text', value: m.attachPath,
        placeholder: '/path/to/project 或 ~/projects/foo',
        oninput: e => { m.attachPath = e.target.value; },
      }),
    ));
  } else {
    modal.appendChild(el('label', { className: 'modal-label' }, '父目录',
      el('input', {
        className: 'modal-input', type: 'text', value: m.parentDir,
        placeholder: '~/projects',
        oninput: e => { m.parentDir = e.target.value; renderInitPathPreview(m); },
      }),
    ));
    modal.appendChild(el('label', { className: 'modal-label' }, '项目名',
      el('input', {
        className: 'modal-input', type: 'text', value: m.name,
        placeholder: 'my-new-project',
        oninput: e => { m.name = e.target.value; renderInitPathPreview(m); },
      }),
    ));
    modal.appendChild(el('div', { id: 'init-path-preview', className: 'init-path-preview' },
      initPathPreviewText(m)));
  }

  if (m.alreadyInitialized) {
    modal.appendChild(el('div', { className: 'init-notice' },
      '该项目已接入过任务队列（存在 .tasks/project.config.js）。',
      el('button', { className: 'btn', onclick: submitRegisterOnly }, '仅注册到面板'),
    ));
  }

  modal.appendChild(el('div', { className: 'modal-actions' },
    el('button', { className: 'btn', onclick: closeInitModal }, '取消'),
    el('button', {
      className: 'btn primary', disabled: m.loading, onclick: initModalNext,
    }, m.loading ? '检测中…' : '下一步'),
  ));
}

function initPathPreviewText(m) {
  const parent = (m.parentDir || '').trim().replace(/\/+$/, '');
  const name = (m.name || '').trim();
  return parent && name ? `→ ${parent}/${name}` : ' ';
}

function renderInitPathPreview(m) {
  const box = document.getElementById('init-path-preview');
  if (box) box.textContent = initPathPreviewText(m);
}
```

注：`el()` 对 `disabled` 等布尔 attr 的处理沿用现有实现（`web/app.js:47`），若它只支持属性赋值则与现有 modal 一致即可。

- [ ] **Step 4: CSS（web/styles.css 末尾追加）**

```css
/* ---------- 接入项目向导 ---------- */
.add-project-btn { width: 100%; margin-top: 10px; }
.init-modal { width: min(560px, 92vw); max-height: 86vh; overflow-y: auto; }
.init-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.init-tab {
  flex: 1; padding: 6px 0; border: 1px solid var(--border, #444);
  background: transparent; color: var(--text); border-radius: 6px; cursor: pointer;
}
.init-tab.active { border-color: var(--accent); color: var(--accent); }
.init-path-preview { font-size: 12px; opacity: 0.7; margin: 2px 0 8px; min-height: 16px; }
.init-notice {
  display: flex; align-items: center; gap: 10px; font-size: 13px;
  padding: 8px; border: 1px solid var(--border, #444); border-radius: 6px; margin: 8px 0;
}
.init-scope-block {
  border: 1px solid var(--border, #444); border-radius: 8px;
  padding: 10px; margin-bottom: 10px;
}
.init-scope-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.tpl-preview {
  font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap;
  background: var(--bg-soft, rgba(127,127,127,0.1)); border-radius: 6px;
  padding: 6px 8px; margin-top: 4px;
}
.tpl-warning { color: var(--red, #e5534b); font-size: 12px; margin-top: 2px; }
```

- [ ] **Step 5: 人工冒烟**

Run: `node tasks.cjs dashboard --port 5790`
浏览器打开 `http://127.0.0.1:5790`，验证：侧栏底部出现按钮 → modal 双 tab 切换正常 → attach 填不存在路径报错、填真实项目进第二步（第二步此时尚未实现 `renderInitStep2`，临时会抛错——先在 `renderInitModal` 里对 `m.step === 2` 显示占位文本 `'(第二步 Task 9 实现)'` 也可，Task 9 替换）。
验证后 Ctrl-C 关停。

- [ ] **Step 6: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "dashboard: 接入项目向导第一步(双 tab 路径选择+仅注册兜底)"
```

---

### Task 9: 前端 — 向导第二步（4 问表单）+ 提交

**Files:**
- Modify: `web/app.js`（向导函数块追加）

- [ ] **Step 1: detect → 表单 state**

```js
/**
 * 从 detect 结果构建第二步表单 state。
 * packages 为空(从零新建/无 package.json)时用空项目默认值:
 * scope=main, dir='.', versionFile='package.json', 模块=['全局']。
 */
function buildFormFromDetect(detect) {
  const pkgs = (detect && detect.packages && detect.packages.length > 0)
    ? detect.packages
    : [{ dir: '.', version: '0.1.0', versionFile: 'package.json',
         buildCommand: '', changelogFile: null, candidateModules: [] }];
  const seen = new Set();
  const scopes = pkgs.map(pkg => {
    let scope = defaultScopeName(pkg.dir);
    while (seen.has(scope)) scope = scope + '2';
    seen.add(scope);
    return {
      scope,
      dir: pkg.dir,
      version: pkg.version || '1.0.0',
      versionFile: pkg.versionFile || (pkg.dir === '.' ? 'package.json' : pkg.dir + '/package.json'),
      buildCommand: pkg.buildCommand || '',
      changelogFile: pkg.changelogFile || '',
      autoCommit: scope === 'web',   // CLI 流程推荐:仅 web 类 scope 自动 commit
      template: defaultCommitTemplate(scope),
      _chipForm: { tags: (pkg.candidateModules && pkg.candidateModules.length > 0)
        ? [...pkg.candidateModules] : ['全局'] },
    };
  });
  return {
    scopes,
    sameDayShareVersion: !detect || detect.sameDayShareVersion !== 'likely_false',
  };
}

function defaultScopeName(dir) {
  if (dir === '.') return 'main';
  const base = dir.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return base || 'main';
}

/** 默认 commit 模板。护栏:T#0000 字面量;subject 行不放 {desc}/{summary}。 */
function defaultCommitTemplate(scope) {
  return `T#0000 ${scope}## {version}\n\n【{module}】{desc}；`;
}

/** 渲染模板示例预览(与 project.config.js commitMessage 的占位符一致)。 */
function renderTemplateExample(s) {
  return s.template
    .replace('{version}', s.version)
    .replace('{module}', s._chipForm.tags[0] || '全局')
    .replace('{desc}', '修复登录跳转')
    .replace('{summary}', '');
}

/** commit 模板护栏检查,返回警告文案或空串。 */
function templateWarning(tpl) {
  const subject = String(tpl).split('\n')[0];
  if (tpl.includes('T#{id}')) return '请保持 T#0000 字面量，不要参数化成 T#{id}';
  if (subject.includes('{desc}') || subject.includes('{summary}')) {
    return 'subject 行不应包含 {desc}/{summary}——那是 git log --oneline 看到的位置';
  }
  return '';
}
```

- [ ] **Step 2: 第二步 DOM**

```js
function renderInitStep2(modal, m) {
  const f = m.form;

  for (const s of f.scopes) {
    const block = el('div', { className: 'init-scope-block' });
    // scope 名(可编辑) + 自动 commit checkbox
    block.appendChild(el('div', { className: 'init-scope-title' }, `目录 ${s.dir}`));
    block.appendChild(el('div', { className: 'modal-row' },
      el('label', { className: 'modal-label' }, 'scope 名',
        el('input', {
          className: 'modal-input', type: 'text', value: s.scope,
          oninput: e => { s.scope = e.target.value.trim(); },
        }),
      ),
      el('label', { className: 'modal-label init-autocommit' },
        el('input', {
          type: 'checkbox', checked: s.autoCommit,
          onchange: e => { s.autoCommit = e.target.checked; },
        }),
        ' 完成任务后自动 commit',
      ),
    ));
    // commit 模板 + 实时预览 + 护栏警告
    const previewBox = el('div', { className: 'tpl-preview' }, renderTemplateExample(s));
    const warnBox = el('div', { className: 'tpl-warning' }, templateWarning(s.template));
    block.appendChild(el('label', { className: 'modal-label' }, 'commit 模板',
      el('textarea', {
        className: 'modal-input', rows: 3, value: s.template,
        oninput: e => {
          s.template = e.target.value;
          previewBox.textContent = renderTemplateExample(s);
          warnBox.textContent = templateWarning(s.template);
        },
      }),
    ));
    block.appendChild(previewBox);
    block.appendChild(warnBox);
    // 候选模块 chip-input(复用现有控件,无补全候选)
    block.appendChild(el('label', { className: 'modal-label' }, '候选模块'));
    block.appendChild(buildTagInput(s._chipForm, []));
    modal.appendChild(block);
  }

  // 同日版本号复用
  modal.appendChild(el('label', { className: 'modal-label init-sameday' },
    el('input', {
      type: 'checkbox', checked: f.sameDayShareVersion,
      onchange: e => { f.sameDayShareVersion = e.target.checked; },
    }),
    ' 同一天多次提交复用同一个版本号',
  ));

  // 非 git 仓库的 git init 选项(attach 才出现)
  if (m.tab === 'attach' && !m.isGitRepo) {
    modal.appendChild(el('label', { className: 'modal-label init-gitinit' },
      el('input', {
        type: 'checkbox', checked: m.gitInit,
        onchange: e => { m.gitInit = e.target.checked; },
      }),
      ' 该目录不是 git 仓库，同时执行 git init（不勾则任务的 commit 流程不可用）',
    ));
  }

  modal.appendChild(el('div', { className: 'modal-actions' },
    el('button', { className: 'btn', onclick: () => { m.step = 1; m.error = ''; renderInitModal(); } }, '上一步'),
    el('button', {
      className: 'btn primary', disabled: m.submitting, onclick: submitInitModal,
    }, m.submitting ? '创建中…' : (m.tab === 'create' ? '创建并初始化' : '接入')),
  ));
}
```

- [ ] **Step 3: 提交**

```js
async function submitInitModal() {
  const m = state.initModal;
  if (!m || m.submitting) return;
  // scope 名校验:非空 + 不重名
  const names = m.form.scopes.map(s => s.scope);
  if (names.some(n => !n)) { m.error = 'scope 名不能为空'; renderInitModal(); return; }
  if (new Set(names).size !== names.length) { m.error = 'scope 名不能重复'; renderInitModal(); return; }

  const answers = {
    autoCommitScopes: m.form.scopes.filter(s => s.autoCommit).map(s => s.scope),
    scopeMapping: {},
    candidateModules: {},
    commitTemplate: {},
    sameDayShareVersion: m.form.sameDayShareVersion,
  };
  for (const s of m.form.scopes) {
    answers.scopeMapping[s.scope] = {
      dir: s.dir, versionFile: s.versionFile,
      changelogFile: s.changelogFile, buildCommand: s.buildCommand,
    };
    answers.candidateModules[s.scope] = s._chipForm.tags.length > 0 ? s._chipForm.tags : ['全局'];
    answers.commitTemplate[s.scope] = s.template;
  }

  m.submitting = true; m.error = ''; renderInitModal();
  const r = await postAction('/api/init', {
    mode: m.tab, root: m.root, gitInit: m.gitInit, answers,
  });
  m.submitting = false;
  if (r.ok) {
    if (m.tab === 'create' && m.parentDir.trim()) {
      localStorage.setItem(INIT_PARENT_KEY, m.parentDir.trim());
    }
    closeInitModal();
    if (r.body.warning) showToast(r.body.warning, 'info', 8000);
    await refreshProjects();
    selectProject(r.body.slug);
  } else {
    m.error = r.body?.error || `失败 (${r.status})`;
    renderInitModal();
  }
}
```

- [ ] **Step 4: 人工冒烟（全流程）**

Run: `node tasks.cjs dashboard --port 5790`
验证四条链路：
1. attach 一个真实 Node 项目 → 第二步预填正确 → 接入 → 侧栏出现并选中，`git log -1` 是 `task-queue: 接入任务队列（ignore .tasks/）` 且只含 `.gitignore`；
2. create 到 `/tmp/tq-smoke/<name>` → 目录被创建、`package.json` + `.tasks/` 齐全、首 commit 含两个文件；
3. attach 一个已接入项目 → 「仅注册到面板」可用；
4. commit 模板里输入 `T#{id}` / subject 加 `{desc}` → 出现护栏警告文案。
清理 `/tmp/tq-smoke` 与 registry 测试条目后关停。

- [ ] **Step 5: Commit**

```bash
git add web/app.js
git commit -m "dashboard: 接入项目向导第二步(4 问表单+模板护栏预览+提交)"
```

---

### Task 10: 文档同步 + 全量回归

**Files:**
- Modify: `SKILL.md`（喊词表 + §init 收尾）
- Modify: `README.md`（§4 面板能力）

- [ ] **Step 1: SKILL.md**

喊词表（`## 用户喊词识别`）加一行：

```markdown
| "在面板上接入/新建项目" | 提示打开 dashboard 点侧栏底部「＋ 接入项目」，向导等价于 §init 流程 |
```

`## §init 流程` 开头加一句：

```markdown
新项目首次接入，4 个问题搞定。也可以不走会话：dashboard 侧栏底部「＋ 接入项目」提供等价的 Web 向导（支持接入已有目录 / 从零新建）。
```

- [ ] **Step 2: README.md**

`### 4. 打开 dashboard 看进度` 的「面板能力」列表里加一行：

```markdown
- **＋ 接入项目**：侧栏底部按钮，双 tab 向导（接入已有目录 / 从零新建并 git init），表单复刻 init 4 问，提交即落盘 `.tasks/` 并自动 commit `.gitignore`
```

- [ ] **Step 3: 全量回归**

Run: `npm test`
Expected: 全部 PASS（含既有 438+ 用例与本计划新增用例）

- [ ] **Step 4: Commit**

```bash
git add SKILL.md README.md
git commit -m "docs: dashboard「＋ 接入项目」入口与向导说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1 双 tab 向导/4 问表单/护栏预览（Task 8-9）、§2 抽核心/两个 API/create 脚手架/pathspec commit（Task 1-7）、§3 路径防呆/空项目默认/不回滚/幂等（Task 4-5、buildFormFromDetect）、§4 测试（各任务 + Task 10 回归）。「仅注册到面板」兜底 → register 模式（Task 5/7/8）。无缺口。
- **类型一致性**：answers 结构（autoCommitScopes/scopeMapping/candidateModules/commitTemplate/sameDayShareVersion）在 Task 5/7/9 三处形态一致；`runInit` 返回 `{slug, root, committed, warning}` 与 handler/前端消费一致。
- **占位符**：Task 1/2 的「原样搬入」指从现文件整函数搬移（源码已在仓库中，非 TBD）；其余步骤均含完整代码。
