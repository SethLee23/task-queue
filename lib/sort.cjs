'use strict';

const { normalizePriority } = require('./states.cjs');

/**
 * 把任务行按"优先级升序（高=1<中=2<低=3）+ 创建时间升序"原地排序，返回同一数组
 * @param {Array<{priority?: string, ctime?: string}>} rows
 * @returns {Array} 排序后的原数组（in-place）
 */
function sortByPriorityAndCtime(rows) {
  return rows.sort((a, b) => {
    const dp = normalizePriority(a.priority) - normalizePriority(b.priority);
    if (dp !== 0) return dp;
    return (a.ctime || '').localeCompare(b.ctime || '');
  });
}

module.exports = { sortByPriorityAndCtime };
