// commands/set-task-model.cjs — 设置任务级模型覆盖（优先级高于项目级 desiredModel）
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex,
} = require('../lib/workbook.cjs');
const { VALID_MODELS } = require('../lib/registry.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * 给 id 任务写 model 列；传空字符串清除覆盖（回退项目级）。
 * @param {string} projectRoot
 * @param {{ id: number|string, model: string }} fields
 * @returns {Promise<{ id: number|string, model: string }>}
 */
async function setTaskModelCore(projectRoot, fields) {
  const { id } = fields;
  const model = String(fields.model || '').trim();
  if (id == null || id === '') throw new Error('set-task-model 需要 id 参数');
  if (model && !VALID_MODELS.includes(model)) {
    throw new Error(`不支持的模型: ${model}（可选: ${VALID_MODELS.join('/')} 或空字符串清除覆盖）`);
  }

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(id));
  if (!target) throw new Error(`未找到 id=${id} 的任务`);

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(target._rowNumber);
    row.getCell(colIndex('model')).value = model;
    row.commit();
  });

  new Logger(projectRoot).info(`task #${id} model → ${model || '(回退项目级)'}`);
  return { id: target.id, model };
}

/**
 * CLI 入口：args = [id, model]
 * @param {string} projectRoot
 * @param {string[]} args
 */
async function cli(projectRoot, args) {
  const [idArg, modelArg = ''] = args;
  const result = await setTaskModelCore(projectRoot, { id: idArg, model: modelArg });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = cli;
module.exports.setTaskModelCore = setTaskModelCore;
