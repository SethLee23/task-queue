// commands/claim.cjs
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, COLUMNS, SHEET_IN_PROGRESS, colIndex,
} = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { sortByPriorityAndCtime } = require('../lib/sort.cjs');

/**
 * 把指定 id 的任务状态改为"进行中"。
 * idArg='auto' 时自动取最高优先级待办；
 * 若该行无 id 则分配现有最大 id + 1；
 * 若 id 不存在或状态不合法则抛错。
 * @param {string} projectRoot 项目根目录
 * @param {string[]} args  args[0] = 任务 id（数字字符串）或 'auto'
 */
module.exports = async function claim(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('claim 需要 id 参数（或 "auto"）');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);

  let targetRow;
  let assignedId;

  if (idArg === 'auto') {
    const todos = rows.filter(r => r.status === STATES.TODO);
    sortByPriorityAndCtime(todos);
    if (todos.length === 0) throw new Error('队列里没有待办任务');
    targetRow = todos[0];
  } else {
    targetRow = rows.find(r => String(r.id) === String(idArg));
    if (!targetRow) throw new Error(`未找到 id=${idArg} 的任务`);
  }

  if (!canTransition(targetRow.status, STATES.IN_PROGRESS)) {
    throw new Error(`非法转换：${targetRow.status} → 进行中`);
  }

  // id 为空（含空字符串）且不为数字 0 时，分配最大 id + 1
  if (!targetRow.id && targetRow.id !== 0) {
    const maxId = rows.reduce((m, r) => {
      const n = parseInt(r.id, 10);
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    assignedId = maxId + 1;
  }

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(targetRow._rowNumber);
    row.getCell(colIndex('status')).value = STATES.IN_PROGRESS;
    if (assignedId != null) {
      row.getCell(colIndex('id')).value = assignedId;
    }
    if (!targetRow.ctime) {
      row.getCell(colIndex('ctime')).value = new Date().toISOString();
    }
    row.commit();
  });

  process.stdout.write(JSON.stringify({
    id: assignedId != null ? assignedId : targetRow.id,
    desc: targetRow.desc,
    scope: targetRow.scope,
    priority: targetRow.priority,
    note: targetRow.note,
  }) + '\n');
};
