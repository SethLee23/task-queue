// commands/del-checklist.cjs — 删第 N 条子项
//
// 用法: tasks.cjs del-checklist <root> <id> <index-1-based>
//
'use strict';

const { applyChecklistMutation } = require('../lib/checklist-apply.cjs');
const { delItem } = require('../lib/checklist.cjs');
const { Logger } = require('../lib/logger.cjs');

async function cli(projectRoot, args) {
  const [idArg, idxArg] = args;
  if (idArg == null || idArg === '') throw new Error('del-checklist 需要 <id>');
  if (idxArg == null || idxArg === '') throw new Error('del-checklist 需要 <index>');
  const result = await applyChecklistMutation(projectRoot, idArg, items => delItem(items, idxArg));
  new Logger(projectRoot).info(`task #${idArg} checklist [${idxArg}] 删除`);
  process.stdout.write(JSON.stringify({ id: result.id, items: result.after }) + '\n');
}

module.exports = cli;
