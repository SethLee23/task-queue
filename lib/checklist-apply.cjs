// lib/checklist-apply.cjs — checklist mutation 的工作簿包装层
//
// 共用模式: 读取 in-progress sheet 中指定 id 的 checklist → 跑 mutator → 序列化写回。
// 不允许操作 archived sheet 中的任务(完成后不该再改清单)。
//
'use strict';

const path = require('node:path');
const {
  withWorkbook, SHEET_IN_PROGRESS, colIndex,
} = require('./workbook.cjs');
const {
  parseChecklist, serializeChecklist,
} = require('./checklist.cjs');

/**
 * 在工作簿上对某条任务的 checklist 字段做一次原子 mutation。
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {number|string} taskId 任务 id
 * @param {(items: {text:string,done:boolean}[]) => {text:string,done:boolean}[]} mutator
 *   纯函数,接收当前 checklist 数组,返回新数组
 * @returns {Promise<{ id: number, before: any[], after: any[] }>}
 */
async function applyChecklistMutation(projectRoot, taskId, mutator) {
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const wantId = String(taskId);
  let before = [];
  let after = [];

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const checklistColIdx = colIndex('checklist');

    // 找到 id 列对应的行
    const idColIdx = colIndex('id');
    let targetRow = null;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const cellVal = row.getCell(idColIdx).value;
      if (cellVal != null && String(cellVal) === wantId) {
        targetRow = row;
      }
    });
    if (!targetRow) {
      throw new Error(`找不到 id=${taskId} 的进行中任务(归档任务不可改 checklist)`);
    }

    const raw = targetRow.getCell(checklistColIdx).value;
    before = parseChecklist(raw == null ? '' : raw);
    after = mutator(before);
    targetRow.getCell(checklistColIdx).value = serializeChecklist(after);
  });

  return { id: Number(taskId), before, after };
}

module.exports = { applyChecklistMutation };
