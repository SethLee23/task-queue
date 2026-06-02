// commands/set-checklist.cjs — 一次性替换任务的整个 checklist(常用于第一次拆解)
//
// 用法: tasks.cjs set-checklist <root> <id> "step1|step2|step3"
//
// 入参形态:
//   - 第三参数为 |/换行 分隔字符串 → 每段当作未勾选子项
//   - 空串 → 清空 checklist
//
'use strict';

const { applyChecklistMutation } = require('../lib/checklist-apply.cjs');
const { fromPipeString } = require('../lib/checklist.cjs');
const { Logger } = require('../lib/logger.cjs');

async function cli(projectRoot, args) {
  const [idArg, pipeStr = ''] = args;
  if (idArg == null || idArg === '') throw new Error('set-checklist 需要 <id> 参数');
  const next = fromPipeString(pipeStr);
  const result = await applyChecklistMutation(projectRoot, idArg, () => next);
  new Logger(projectRoot).info(`task #${idArg} checklist 重置为 ${next.length} 项`);
  process.stdout.write(JSON.stringify({ id: result.id, items: result.after }) + '\n');
}

module.exports = cli;
