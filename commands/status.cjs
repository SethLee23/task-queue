'use strict';

const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { localDateStr } = require('../lib/datetime.cjs');
const { readPaused } = require('../lib/paused.cjs');

/**
 * 判断 ftime 是否属于今天（本地时区）。
 * ftime 可能是 Date 对象、ISO string 或空值。
 * @param {unknown} ftime
 * @param {string} today YYYY-MM-DD 格式的今日日期
 * @returns {boolean}
 */
function isToday(ftime, today) {
  if (!ftime) return false;
  const d = ftime instanceof Date ? ftime : new Date(/** @type {string} */ (ftime));
  if (Number.isNaN(d.getTime())) return false;
  return localDateStr(d) === today;
}

/**
 * 输出当前任务状态统计 JSON 到 stdout。
 * 格式：{ todo, in_progress, review, blocked, done_today }
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} _args 未使用
 * @returns {Promise<void>}
 */
module.exports = async function status(projectRoot, _args) {
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const inProg = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const archived = await readRows(xlsxPath, SHEET_ARCHIVED);

  const today = localDateStr();
  const pauseReason = readPaused(projectRoot);
  const counts = {
    todo:        inProg.filter(r => r.status === STATES.TODO).length,
    in_progress: inProg.filter(r => r.status === STATES.IN_PROGRESS).length,
    review:      inProg.filter(r => r.status === STATES.REVIEW).length,
    blocked:     inProg.filter(r => r.status === STATES.BLOCKED).length,
    done_today:  archived.filter(r => {
      if (r.status !== STATES.DONE) return false;
      return isToday(r.ftime, today);
    }).length,
    paused:      pauseReason !== null,
    pauseReason: pauseReason,
  };
  process.stdout.write(JSON.stringify(counts) + '\n');
};
