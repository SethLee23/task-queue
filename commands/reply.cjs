// commands/reply.cjs — 在任务 note 顶部追加用户答复，可选恢复为 todo
'use strict';

const path = require('node:path');
const {
  readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex,
} = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * 本地 YYYY-MM-DD HH:mm（不要 ISO，便于人读）。
 * @returns {string}
 */
function localTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 核心实现，供 CLI 与 dashboard server 共用。
 *
 * 行为：
 * - 把 reply 以 `[reply 时间] reply\n---\n` 前缀写到 note 顶部
 * - resume=true 时：
 *   - 当前状态必须 ∈ {BLOCKED, REVIEW}
 *   - 状态改为 TODO，对应阻塞/风险字段清空
 *
 * @param {string} projectRoot 项目根目录
 * @param {{ id: number|string, reply: string, resume?: boolean }} fields
 * @returns {Promise<{ id: number|string, status: string, note: string, resumed: boolean }>}
 */
async function replyCore(projectRoot, fields) {
  const { id, reply } = fields;
  const resume = !!fields.resume;
  if (id == null || id === '') throw new Error('reply 需要 id 参数');
  const replyText = String(reply || '').trim();
  if (!replyText) throw new Error('reply 内容不能为空');

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(id));
  if (!target) throw new Error(`未找到 id=${id} 的任务`);

  if (resume && target.status !== STATES.BLOCKED && target.status !== STATES.REVIEW) {
    throw new Error(`resume 仅适用于 阻塞/待review 状态，当前: ${target.status}`);
  }
  if (resume && !canTransition(target.status, STATES.TODO)) {
    throw new Error(`非法转换：${target.status} → ${STATES.TODO}`);
  }

  const oldNote = String(target.note || '');
  const ts = localTimestamp();
  let block;
  if (resume && target.status === STATES.BLOCKED && String(target.question || '').trim()) {
    block = `[reply ${ts}]\nQ: ${String(target.question).trim()}\nA: ${replyText}`;
  } else if (resume && target.status === STATES.REVIEW && String(target.risk || '').trim()) {
    block = `[reply ${ts}]\nRisk: ${String(target.risk).trim()}\nA: ${replyText}`;
  } else {
    block = `[reply ${ts}] ${replyText}`;
  }
  const newNote = oldNote ? `${block}\n---\n${oldNote}` : block;

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(target._rowNumber);
    row.getCell(colIndex('note')).value = newNote;
    if (resume) {
      row.getCell(colIndex('status')).value = STATES.TODO;
      if (target.status === STATES.BLOCKED) {
        row.getCell(colIndex('question')).value = '';
      } else if (target.status === STATES.REVIEW) {
        row.getCell(colIndex('risk')).value = '';
      }
    }
    row.commit();
  });

  new Logger(projectRoot).info(
    `task #${target.id} reply${resume ? ' + resume→todo' : ''}: ${replyText.slice(0, 60)}`,
  );

  return {
    id: target.id,
    status: resume ? STATES.TODO : target.status,
    note: newNote,
    resumed: resume,
  };
}

/**
 * CLI 入口：args = [id, reply, resume?]，resume 为字符串 "true"/"1" 视为 true。
 *
 * @param {string} projectRoot
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function replyCli(projectRoot, args) {
  const [idArg, replyArg, resumeArg] = args;
  const resume = resumeArg === 'true' || resumeArg === '1';
  const result = await replyCore(projectRoot, { id: idArg, reply: replyArg, resume });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = replyCli;
module.exports.replyCore = replyCore;
