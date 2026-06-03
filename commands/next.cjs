// commands/next.cjs
'use strict';

const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { sortByPriorityAndCtime } = require('../lib/sort.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');

/**
 * 从"进行中" sheet 取最高优先级 + 最早创建时间的待办，输出 JSON 到 stdout。
 * 无待办时输出 null（或 --limit 模式下输出 []）。
 * @param {string} projectRoot 项目根目录
 * @param {string[]} args 命令参数；支持 --limit N 返回最多 N 条的数组
 */
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
  // 去掉内部字段 _rowNumber，避免暴露实现细节
  const out = { ...picked };
  delete out._rowNumber;
  process.stdout.write(JSON.stringify(out) + '\n');
};
