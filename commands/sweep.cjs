'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED } = require('../lib/workbook.cjs');
const { ARCHIVED_SHEET_STATES } = require('../lib/states.cjs');
const { Logger } = require('../lib/logger.cjs');

/** 任务行里会引用附件路径的文本字段 */
const ATTACH_REF_FIELDS = ['desc', 'note', 'risk', 'question'];

/**
 * 扫两 sheet 所有行的 ATTACH_REF_FIELDS,收集所有 .tasks/attachments/xxx 引用。
 * @param {Array<object>} allRows
 * @returns {Set<string>} 文件名集合(不含路径前缀)
 */
function collectReferencedAttachments(allRows) {
  const refs = new Set();
  const re = /\.tasks\/attachments\/([\w.\-:]+\.(?:png|jpe?g|gif|webp))/gi;
  for (const row of allRows) {
    for (const field of ATTACH_REF_FIELDS) {
      const text = row[field];
      if (!text || typeof text !== 'string') continue;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        refs.add(m[1]);
      }
    }
  }
  return refs;
}

/**
 * 扫 .tasks/attachments/ 目录,删除不被两 sheet 任何行引用的孤儿文件。
 * 目录不存在时直接返回 0。
 * @param {string} projectRoot
 * @param {Array<object>} allRowsAfterSweep sweep 完后的两 sheet 联合行集合
 * @returns {Promise<number>} 删除的孤儿数量
 */
async function gcOrphanAttachments(projectRoot, allRowsAfterSweep) {
  const dir = path.join(projectRoot, '.tasks', 'attachments');
  if (!fs.existsSync(dir)) return 0;
  const referenced = collectReferencedAttachments(allRowsAfterSweep);
  const files = fs.readdirSync(dir).filter(f => {
    const abs = path.join(dir, f);
    try { return fs.statSync(abs).isFile(); } catch (_) { return false; }
  });
  let deleted = 0;
  for (const f of files) {
    if (!referenced.has(f)) {
      try {
        fs.unlinkSync(path.join(dir, f));
        deleted += 1;
      } catch (_) { /* best-effort */ }
    }
  }
  return deleted;
}

/**
 * 将进行中 sheet 里状态为"已完成/跳过"的行剪切到已完结 sheet,
 * 然后 GC 不再被任何行引用的孤儿附件。
 *
 * 从后往前删行,避免 spliceRows 导致行号偏移。
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} _args 未使用
 * @returns {Promise<void>}
 */
module.exports = async function sweep(projectRoot, _args) {
  const xlsxPath = path.join(projectRoot, '.tasks', 'tasks.xlsx');
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const toArchive = rows.filter(r => ARCHIVED_SHEET_STATES.includes(r.status));

  if (toArchive.length > 0) {
    // 从后往前删，避免行号偏移
    const sortedDesc = [...toArchive].sort((a, b) => b._rowNumber - a._rowNumber);

    await withWorkbook(xlsxPath, async wb => {
      const wsIn = wb.getWorksheet(SHEET_IN_PROGRESS);
      const wsArch = wb.getWorksheet(SHEET_ARCHIVED);
      for (const r of sortedDesc) {
        // 剥离内部字段 _rowNumber，避免写入 Excel 列
        const { _rowNumber, ...cleanRow } = r;
        wsArch.addRow(cleanRow);
        wsIn.spliceRows(_rowNumber, 1);
      }
    });

    new Logger(projectRoot).info(`swept ${toArchive.length} rows to 已完结`);
  }

  // 再读一遍 sheet 拿最新行,做孤儿附件 GC
  const inRows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const archRows = await readRows(xlsxPath, SHEET_ARCHIVED);
  const orphans = await gcOrphanAttachments(projectRoot, [...inRows, ...archRows]);

  if (orphans > 0) {
    new Logger(projectRoot).info(`gc'd ${orphans} 孤儿附件`);
  }

  process.stdout.write(JSON.stringify({
    archived: toArchive.length,
    attachmentsDeleted: orphans,
  }) + '\n');
};

module.exports.collectReferencedAttachments = collectReferencedAttachments;
module.exports.gcOrphanAttachments = gcOrphanAttachments;
