'use strict';

const path = require('node:path');
const { readRows, withWorkbook, colIndex, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');
const { listOrphans, destroyForTask } = require('../lib/worktree.cjs');
const { transitionToReview } = require('../lib/done-core.cjs');

/**
 * 将进行中 sheet 里所有"进行中"状态的行重置为"待办"，
 * 并在 note 字段追加中断标记，用于系统重启/crash 后的任务恢复。
 * 完成后扫描 worktree orphan，按矩阵处置不一致状态。
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} _args 未使用
 * @returns {Promise<void>}
 */
module.exports = async function recover(projectRoot, _args) {
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const stuck = rows.filter(r => r.status === STATES.IN_PROGRESS);

  if (stuck.length > 0) {
    // 精确时间戳用于追责（UTC ISO 比本地日期更有价值）
    const stamp = new Date().toISOString();

    await withWorkbook(xlsxPath, async wb => {
      const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
      for (const r of stuck) {
        const row = ws.getRow(r._rowNumber);
        row.getCell(colIndex('status')).value = STATES.TODO;
        const prevNote = r.note || '';
        const tag = `[上次中断已重排队 ${stamp}]`;
        row.getCell(colIndex('note')).value = prevNote ? `${prevNote}\n${tag}` : tag;
        row.commit();
      }
    });

    new Logger(projectRoot).warn(`recovered ${stuck.length} stuck task(s)`);
  }

  // ── worktree orphan 扫描(并行模式崩溃兜底)──
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
      await transitionToReview(xlsxPath, task._rowNumber,
        `recover 发现 worktree task-${o.taskId} 与任务状态(${task.status})不一致,转 review。`
        + `worktree 保留在 .tasks/worktrees/task-${o.taskId}`,
        logger, projectRoot, task.id);
      orphanActions.push({ taskId: o.taskId, action: 'to-review' });
    }
  }
  process.stdout.write(JSON.stringify({ recovered: stuck.length, orphans: orphanActions }) + '\n');
};
