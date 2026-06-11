// lib/init-flow.cjs — dashboard「接入项目」编排:路径校验/探测/脚手架/init+commit
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { initCore } = require('./init-core.cjs');
const { add: registryAdd } = require('./registry.cjs');
const { gitAdd, gitInitRepo, gitCommitPaths } = require('./git.cjs');

/** init 完成后 .gitignore 的提交信息（与 CLI init 流程同款） */
const INIT_COMMIT_MESSAGE = 'task-queue: 接入任务队列（ignore .tasks/）';

/** 物理规范化后的 home 目录（处理 firmlink / symlink / 大小写不敏感 FS） */
const _realHome = (() => {
  try { return fs.realpathSync.native(os.homedir()); } catch (_) { return os.homedir(); }
})();

/**
 * 规范化用户输入路径：展开 ~、要求绝对路径、resolve 掉 ../，
 * 并拒绝文件系统根目录和 home 目录本身这类危险目标。
 * 对已存在路径做 best-effort realpath 规范化，防止路径别名绕过守卫。
 * @param {string} raw 用户输入
 * @returns {string} 规范化后的绝对路径
 */
function resolveInitPath(raw) {
  if (typeof raw !== 'string') throw new Error('路径必须是字符串');
  let p = raw.trim();
  if (!p) throw new Error('路径不能为空');
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new Error(`需要绝对路径: ${p}`);
  p = path.resolve(p);
  // best-effort 物理规范化：解开 symlink / firmlink / 大小写别名
  try { p = fs.realpathSync.native(p); } catch (_) { /* 不存在的路径（create 模式目标）保持原值 */ }
  if (p === path.parse(p).root) throw new Error('不允许使用文件系统根目录');
  if (p === _realHome) throw new Error('不允许使用 home 目录本身');
  return p;
}

/**
 * attach 模式校验：root 必须是已存在的目录。
 * @param {string} root 规范化绝对路径
 */
function validateAttachRoot(root) {
  let stat;
  try { stat = fs.statSync(root); } catch (e) { throw new Error(e.code === 'ENOENT' ? `目录不存在: ${root}` : `无法访问: ${root}（${e.code}）`); }
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
 * isGitRepo 用 `git rev-parse --is-inside-work-tree` 判定（cwd=root），
 * 已有仓库的子目录也算 true——避免前端引导用户在 monorepo 子目录里嵌套 git init。
 * @param {string} root
 * @returns {{ isGitRepo: boolean, alreadyInitialized: boolean }}
 */
function inspectRoot(root) {
  let isGitRepo = false;
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    isGitRepo = out.trim() === 'true';
  } catch (_) {
    isGitRepo = false;
  }
  return {
    isGitRepo,
    alreadyInitialized: fs.existsSync(path.join(root, '.tasks', 'project.config.js')),
  };
}

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

module.exports = {
  INIT_COMMIT_MESSAGE,
  resolveInitPath, validateAttachRoot, validateCreateTarget, inspectRoot,
  scaffoldProject, runInit, registerOnly,
};
