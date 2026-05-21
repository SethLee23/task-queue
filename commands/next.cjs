// commands/next.cjs
'use strict';

const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { sortByPriorityAndCtime } = require('../lib/sort.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');

/**
 * 从"进行中" sheet 取最高优先级 + 最早创建时间的待办，输出 JSON 到 stdout。
 * 无待办时输出 null。
 * @param {string} projectRoot 项目根目录
 * @param {string[]} _args 命令参数（暂未使用）
 */
module.exports = async function next(projectRoot, _args) {
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const todos = rows.filter(r => r.status === STATES.TODO);
  sortByPriorityAndCtime(todos);
  if (todos.length === 0) {
    writeHeartbeat(projectRoot, { phase: 'sleeping', currentTaskId: null });
    process.stdout.write('null\n');
    return;
  }
  const picked = todos[0];
  // 去掉内部字段 _rowNumber，避免暴露实现细节
  const out = { ...picked };
  delete out._rowNumber;
  process.stdout.write(JSON.stringify(out) + '\n');
};
