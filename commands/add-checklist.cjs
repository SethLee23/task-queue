// commands/add-checklist.cjs — 追加一条新子项到末尾(用于 loop 干到一半发现要补步骤)
//
// 用法: tasks.cjs add-checklist <root> <id> "text"
//
'use strict';

const { applyChecklistMutation } = require('../lib/checklist-apply.cjs');
const { addItem } = require('../lib/checklist.cjs');
const { Logger } = require('../lib/logger.cjs');

async function cli(projectRoot, args) {
  const [idArg, text = ''] = args;
  if (idArg == null || idArg === '') throw new Error('add-checklist 需要 <id>');
  if (!text || !String(text).trim()) throw new Error('add-checklist 需要 <text>');
  const result = await applyChecklistMutation(projectRoot, idArg, items => addItem(items, text));
  new Logger(projectRoot).info(`task #${idArg} checklist + ${String(text).trim()}`);
  process.stdout.write(JSON.stringify({ id: result.id, items: result.after }) + '\n');
}

module.exports = cli;
