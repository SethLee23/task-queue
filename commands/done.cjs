'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex,
} = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { Logger } = require('../lib/logger.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');
const { localTimestamp } = require('../lib/datetime.cjs');
const { parseChecklist, summarize } = require('../lib/checklist.cjs');
const { gitStatus } = require('../lib/git.cjs');
const {
  buildDoneBlock, prependDoneBlock, transitionToReview, commitAndArchive,
} = require('../lib/done-core.cjs');

/**
 * checklist 未做完时,worker 误调 done 的兜底:状态回退到 TODO,note 顶部追加被拒说明 + worker
 * 给出的 summary,heartbeat 置 idle 但不写 lastFinishedId(任务并未结束)。下一轮 loop 会重新
 * dispatch,worker 看到 checklist 已勾项 + note 里的"上轮被拒"提示后从首个未勾项续做。
 * @param {string} xlsxPath
 * @param {object} target 含 _rowNumber/note 的行对象
 * @param {string} summary worker 误传的完成总结(保留给用户参考)
 * @param {{done:number, total:number, nextUndone:string|null}} s 摘要
 * @param {Logger} logger
 * @param {string} projectRoot
 */
async function revertToTodoForIncompleteChecklist(xlsxPath, target, summary, s, logger, projectRoot) {
  const ts = localTimestamp();
  const nextHint = s.nextUndone ? `,下一项: ${s.nextUndone}` : '';
  const summaryLine = summary && String(summary).trim()
    ? `\nworker summary: ${String(summary).trim()}`
    : '';
  const tag = `[done 被拒 ${ts}] checklist 仅 ${s.done}/${s.total} 完成${nextHint}。任务已回退到待办,下一轮 loop 将续做剩余项。${summaryLine}`;
  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const r = ws.getRow(target._rowNumber);
    r.getCell(colIndex('status')).value = STATES.TODO;
    const prevNote = target.note || '';
    r.getCell(colIndex('note')).value = prevNote ? `${tag}\n---\n${prevNote}` : tag;
    r.commit();
  });
  if (logger) logger.warn(`task #${target.id} done 被拒(checklist ${s.done}/${s.total}),回退到 TODO`);
  writeHeartbeat(projectRoot, { phase: 'idle', currentTaskId: null });
}

/**
 * 标记任务为已完成 + 触发 auto commit（如 scope 允许）。
 *
 * 流程：
 * 1. 校验目标行状态必须为"进行中"
 * 2. scope.autoCommit=false → 转 review
 * 3. 工作区无改动 → 直接归档
 * 4. inferModule 返回 null → 转 review
 * 5. 决定版本号（sameDayShareVersion 命中则复用，否则 bump）
 * 6. 追加 changelog 条目，gitAdd + gitCommit
 * 7. 状态置已完成 + 归档；任何 commit 阶段异常都回退到 review
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} args args[0] = task id
 * @returns {Promise<void>}
 */
module.exports = async function done(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('done 需要 id 参数');
  const summary = args[1];
  const expectClean = args.includes('--expect-clean');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const cfg = loadProjectConfig(projectRoot);
  const logger = new Logger(projectRoot);

  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(idArg));
  if (!target) throw new Error(`未找到 id=${idArg} 的任务`);
  if (target.status !== STATES.IN_PROGRESS) {
    throw new Error(`非法转换：${target.status} → 已完成（必须先 claim 进入进行中）`);
  }

  // checklist 防御:worker 在子项未做完时调 done 是常见误判(prompt 写明也照犯,尤其 Sonnet/Haiku)。
  // 任一项未勾 → 回退到 TODO 让 loop 自动续做,避免用户看到 6/8 进度的任务被错误归档。
  // 空 checklist / 全勾 → 跳过,走正常流程。
  const checklistItems = parseChecklist(target.checklist);
  if (checklistItems.length > 0) {
    const s = summarize(checklistItems);
    if (s.done < s.total) {
      await revertToTodoForIncompleteChecklist(xlsxPath, target, summary, s, logger, projectRoot);
      return;
    }
  }

  // summary 强制要求:空 summary 转 review,避免 dashboard 上"完成区什么都看不到"的体验事故。
  // 触发条件:loop 没读最新 loop-prompt 或人工调 done 时漏传。把 risk 写明白让人/AI 都能 reply 补上。
  if (!summary || !String(summary).trim()) {
    await transitionToReview(
      xlsxPath,
      target._rowNumber,
      'Claude 未提供 summary。loop-prompt.md Step 4a 要求 done 必传 summary —— '
      + '执行型任务写 1-2 句改动/决策,回答型任务直接写完整答案。'
      + '请 reply 补一段答复并 resume,下一轮 loop 重新 done(把答复内容用作 summary)。',
      logger,
      projectRoot,
      target.id,
    );
    return;
  }

  const scopeName = target.scope;
  const scopeCfg = cfg.scopes[scopeName];
  if (!scopeCfg) {
    await transitionToReview(xlsxPath, target._rowNumber, `未识别的 scope: ${scopeName}`, logger, projectRoot, target.id, { summary, oldNote: target.note });
    return;
  }

  if (!scopeCfg.autoCommit) {
    await transitionToReview(
      xlsxPath,
      target._rowNumber,
      `scope ${scopeName} 不允许自动 commit，请人工 review`,
      logger,
      projectRoot,
      target.id,
      { summary, oldNote: target.note },
    );
    return;
  }

  // non-code lane 护栏:声称不改文件的任务,仓库必须干净;脏 → 还原 tracked + review,绝不 commit
  if (expectClean) {
    const dirty = gitStatus(projectRoot).filter(p => !p.startsWith('.tasks/'));
    if (dirty.length > 0) {
      const restored = [];
      const untracked = [];
      for (const f of dirty) {
        try {
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

  const result = await commitAndArchive({ projectRoot, xlsxPath, target, cfg, scopeName, summary, logger });
  if (result.ok && result.commitHash) {
    logger.info(`task #${target.id} done + commit ${result.commitHash} 【${result.moduleName}】 ${result.version}`);
  } else if (result.ok) {
    logger.info(`task #${target.id} done (无文件改动，已归档)`);
  }
};

module.exports.buildDoneBlock = buildDoneBlock;
module.exports.prependDoneBlock = prependDoneBlock;
