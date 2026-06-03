'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { Logger } = require('../lib/logger.cjs');
const { transitionToReview, commitAndArchive } = require('../lib/done-core.cjs');
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
 * @param {string[]} args args[0]=taskId, args[1]=summary(必传)
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

  const ahead = parseInt(git(projectRoot, ['rev-list', '--count', `${base}..${branch}`]).trim(), 10);

  if (ahead > 0) {
    // 合并前固定 base 当前 commit SHA。注意:git merge --ff-only 会把当前分支(base 这个分支名)
    // 推进到 task-N tip —— 合并后 base 名解析到的 SHA 已变,不能再用 `base..HEAD` 数(会得 0)。
    // 故用合并前的 baseSha..HEAD 数实际合进来的 commit 数,reset 时回退到 baseSha。
    // rebase 路径下 task-N 的 1 个 WIP commit 被重放,ff 后 baseSha..HEAD 仍 == 重放后的 commit 数,
    // 比合并前预算的 ahead 更稳(避免 rebase 改变 commit 数时 HEAD~ahead 数错)。
    const baseSha = git(projectRoot, ['rev-parse', 'HEAD']).trim();
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
    const aheadNow = parseInt(git(projectRoot, ['rev-list', '--count', `${baseSha}..HEAD`]).trim(), 10);
    git(projectRoot, ['reset', '--mixed', `HEAD~${aheadNow}`]);
  }

  const result = await commitAndArchive({ projectRoot, xlsxPath, target, cfg, scopeName, summary, logger });

  if (result.review) {
    process.stdout.write(JSON.stringify({ ok: false, taskId: idArg, reason: result.risk }) + '\n');
    return;
  }

  destroyForTask(projectRoot, idArg, { force: true, deleteBranch: true });
  logger.info(`task #${idArg} merge-task 完成 ${result.version || '(无 commit)'}`);
  process.stdout.write(JSON.stringify({
    ok: true, taskId: idArg, commitHash: result.commitHash, version: result.version, module: result.moduleName,
  }) + '\n');
};
