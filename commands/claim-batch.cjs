'use strict';

const path = require('node:path');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, colIndex } = require('../lib/workbook.cjs');
const { STATES, canTransition } = require('../lib/states.cjs');
const { writeHeartbeat } = require('../lib/heartbeat.cjs');

/**
 * 原子批量 claim:校验全部合法后才进 withWorkbook 一次写入;任何一条非法 → 抛错,Excel 不动。
 * @param {string} projectRoot
 * @param {string[]} args id 列表
 */
module.exports = async function claimBatch(projectRoot, args) {
  if (!args || args.length === 0) throw new Error('claim-batch 需要至少 1 个 id');
  const ids = args.map(String);

  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const targets = ids.map(id => {
    const r = rows.find(x => String(x.id) === id);
    if (!r) throw new Error(`未找到 id=${id} 的任务`);
    if (!canTransition(r.status, STATES.IN_PROGRESS)) {
      throw new Error(`非法转换:#${id} ${r.status} → 进行中`);
    }
    return r;
  });

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    for (const t of targets) {
      const row = ws.getRow(t._rowNumber);
      row.getCell(colIndex('status')).value = STATES.IN_PROGRESS;
      if (!t.ctime) row.getCell(colIndex('ctime')).value = new Date().toISOString();
      row.commit();
    }
  });

  writeHeartbeat(projectRoot, {
    phase: 'executing',
    currentTaskIds: targets.map(t => Number(t.id)),
    currentTaskDesc: targets.map(t => `#${t.id} ${t.desc}`).join(' ｜ '),
  });

  process.stdout.write(JSON.stringify({
    claimed: targets.map(t => ({
      id: t.id, desc: t.desc, scope: t.scope, note: t.note,
      model: t.model || '', checklist: t.checklist || '',
    })),
  }) + '\n');
};
