// commands/add-row.cjs — 向 .tasks/tasks.xlsx 进行中表追加一条待办任务
'use strict';

const path = require('node:path');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { STATES, PRIORITY_ORDER } = require('../lib/states.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { VALID_MODELS } = require('../lib/registry.cjs');

const VALID_PRIORITIES = new Set(PRIORITY_ORDER);

/**
 * tags 既可以传 ["a","b"] 数组，也可以传 "a,b" / "a|b" 字符串。
 * 统一规整为以 "|" 分隔的字符串存到 Excel；空 / null / undefined → ""。
 * 同时去重 + 去前后空白 + 丢弃空段。
 * @param {string|string[]|null|undefined} input
 * @returns {string}
 */
function normalizeTags(input) {
  if (input == null) return '';
  const arr = Array.isArray(input)
    ? input
    : String(input).split(/[,|]/);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const t = String(raw).trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join('|');
}

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
 * @param {{ desc: string, scope: string, priority?: string, note?: string, tags?: string|string[], model?: string }} fields
 * @returns {Promise<{ id: number, desc: string, scope: string, priority: string, note: string, tags: string, model: string, status: string, ctime: string }>}
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

  const model = fields.model == null ? '' : String(fields.model).trim();
  if (model && !VALID_MODELS.includes(model)) {
    throw new Error(`非法 model: ${model}（可选: ${VALID_MODELS.join('/')} 或留空跟随项目）`);
  }

  const tags = normalizeTags(fields.tags);

  const note = fields.note || '';
  const ctime = new Date().toISOString();
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');

  const existingRows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const archivedRows = await readRows(xlsxPath, SHEET_ARCHIVED);
  // id 必须在两张表合集里取 max+1,否则归档后 in-progress 清空,新任务又从 1 开始,
  // dashboard 完成区会出现一堆同 id 的卡片完全无法区分。
  const maxId = [...existingRows, ...archivedRows].reduce((m, r) => {
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
      model,
      tags,
    });
  });

  return { id, desc, scope, priority, note, tags, model, status: STATES.TODO, ctime };
}

/**
 * 从 args 里抽出一个带值的 flag，并把它（及其值）从原数组移除。
 * 支持两种写法：--key value 和 --key=value。
 * @param {string[]} args
 * @param {string} name 形如 'tags'
 * @returns {string|undefined}
 */
function extractFlag(args, name) {
  const long = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === long) {
      const val = args[i + 1];
      args.splice(i, 2);
      return val;
    }
    if (typeof a === 'string' && a.startsWith(long + '=')) {
      const val = a.slice(long.length + 1);
      args.splice(i, 1);
      return val;
    }
  }
  return undefined;
}

/**
 * CLI 入口：解析位置参数 + 可选 --tags/--model 后调 addRowCore，结果以 JSON 行写出。
 *
 * 用法：tasks.cjs add-row <root> <desc> <scope> [priority] [note] [--tags a,b,c] [--model opus]
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} args [desc, scope, priority?, note?] + flags
 * @returns {Promise<void>}
 */
async function addRowCli(projectRoot, args) {
  const rest = [...args];
  const tags = extractFlag(rest, 'tags');
  const model = extractFlag(rest, 'model');
  const [desc, scope, priorityArg, noteArg] = rest;
  const result = await addRowCore(projectRoot, {
    desc, scope, priority: priorityArg, note: noteArg, tags, model,
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = addRowCli;
module.exports.addRowCore = addRowCore;
