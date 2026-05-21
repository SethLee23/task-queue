// commands/add-row.cjs — 向 .tasks/tasks.xlsx 进行中表追加一条待办任务
'use strict';

const path = require('node:path');
const { readRows, withWorkbook, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES, PRIORITY_ORDER } = require('../lib/states.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');

const VALID_PRIORITIES = new Set(PRIORITY_ORDER);

/**
 * 追加一条状态为"待办"的任务到进行中 sheet 的核心实现，供 CLI 和 dashboard server 复用。
 * id 按 max+1 即时分配，ctime 自动填本地 ISO 时间戳。
 *
 * 校验：
 * - desc / scope 必填
 * - scope 必须存在于 project.config.js 的 scopes 中
 * - priority 不传默认 '中'，否则必须是 高/中/低 之一
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {{ desc: string, scope: string, priority?: string, note?: string, link?: string }} fields
 * @returns {Promise<{ id: number, desc: string, scope: string, priority: string, note: string, link: string, status: string, ctime: string }>}
 */
async function addRowCore(projectRoot, fields) {
  const { desc, scope } = fields;
  if (!desc) throw new Error('add-row 需要 <desc> 参数');
  if (!scope) throw new Error('add-row 需要 <scope> 参数');

  const priority = fields.priority || '中';
  if (!VALID_PRIORITIES.has(priority)) {
    throw new Error(`非法 priority: ${priority}（需为 ${PRIORITY_ORDER.join('/')} 之一）`);
  }

  const cfg = loadProjectConfig(projectRoot);
  if (!cfg.scopes[scope]) {
    throw new Error(
      `scope "${scope}" 不在 project.config.js 中（可选: ${Object.keys(cfg.scopes).join(', ')}）`,
    );
  }

  const note = fields.note || '';
  const link = fields.link || '';
  const ctime = new Date().toISOString();
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');

  const existingRows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const maxId = existingRows.reduce((m, r) => {
    const n = parseInt(r.id, 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  const id = maxId + 1;

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    ws.addRow({
      id,
      desc,
      scope,
      priority,
      status: STATES.TODO,
      note,
      question: '',
      risk: '',
      ctime,
      ftime: '',
      link,
    });
  });

  return { id, desc, scope, priority, note, link, status: STATES.TODO, ctime };
}

/**
 * CLI 入口：解析位置参数后调 addRowCore，并把结果以 JSON 行写出到 stdout。
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} args [desc, scope, priority?, note?, link?]
 * @returns {Promise<void>}
 */
async function addRowCli(projectRoot, args) {
  const [desc, scope, priorityArg, noteArg, linkArg] = args;
  const result = await addRowCore(projectRoot, {
    desc, scope, priority: priorityArg, note: noteArg, link: linkArg,
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = addRowCli;
module.exports.addRowCore = addRowCore;
