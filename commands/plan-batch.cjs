'use strict';

const path = require('node:path');
const { readRows, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');
const { STATES } = require('../lib/states.cjs');
const { sortByPriorityAndCtime } = require('../lib/sort.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');

/**
 * 并行 Step 1.5:输出候选 + scope 互斥提示,供主 Claude 标 lane / 挑批次。
 * 规则计算只有 scopeMutex(同 scope 两两配对);语义判断(lane / desc 是否独立)由主 Claude 做。
 * @param {string} projectRoot
 * @param {string[]} args 支持 --limit N(默认 5)
 */
module.exports = async function planBatch(projectRoot, args) {
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg.parallel.enabled) {
    process.stdout.write(JSON.stringify({
      candidates: [], scopeMutex: [],
      reason: 'parallel 未启用,走串行 next/claim 路径',
    }) + '\n');
    return;
  }

  let limit = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') { limit = parseInt(args[i + 1], 10) || limit; i++; }
  }

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const todos = rows.filter(r => r.status === STATES.TODO);
  sortByPriorityAndCtime(todos);
  const candidates = todos.slice(0, limit).map(r => ({
    id: r.id, desc: r.desc, scope: r.scope, priority: r.priority,
    note: r.note, model: r.model || '',
  }));

  const scopeMutex = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[i].scope === candidates[j].scope) {
        scopeMutex.push([candidates[i].id, candidates[j].id]);
      }
    }
  }

  process.stdout.write(JSON.stringify({
    candidates, scopeMutex,
    maxConcurrency: cfg.parallel.maxConcurrency,
    allowSameScope: cfg.parallel.allowSameScope,
  }) + '\n');
};
