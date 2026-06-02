// commands/untick-checklist.cjs — 把第 N 个子项标记回未完成
//
// 用法: tasks.cjs untick-checklist <root> <id> <index-1-based>
//
'use strict';

const { applyChecklistMutation } = require('../lib/checklist-apply.cjs');
const { setDone } = require('../lib/checklist.cjs');
const { Logger } = require('../lib/logger.cjs');

async function cli(projectRoot, args) {
  const [idArg, idxArg] = args;
  if (idArg == null || idArg === '') throw new Error('untick-checklist 需要 <id>');
  if (idxArg == null || idxArg === '') throw new Error('untick-checklist 需要 <index>');
  const result = await applyChecklistMutation(projectRoot, idArg, items => setDone(items, idxArg, false));
  new Logger(projectRoot).info(`task #${idArg} checklist [${idxArg}] ☐`);
  process.stdout.write(JSON.stringify({ id: result.id, items: result.after }) + '\n');
}

module.exports = cli;
