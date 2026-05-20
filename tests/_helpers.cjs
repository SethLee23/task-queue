'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createBlankWorkbook, withWorkbook, SHEET_IN_PROGRESS } = require('../lib/workbook.cjs');

/**
 * 创建一个新临时根目录（调用方负责清理），并提供 setupProject 工厂
 * @param {string} prefix mkdtemp 前缀
 * @returns {{ tmpDir: string, setupProject: (rows: object[]) => Promise<string> }}
 */
function createTmpProjectFactory(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  async function setupProject(rows) {
    const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.mkdirSync(path.join(proj, '.tasks'));
    const xlsx = path.join(proj, '.tasks', 'tasks.xlsx');
    await createBlankWorkbook(xlsx);
    if (rows.length > 0) {
      await withWorkbook(xlsx, async wb => {
        const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
        rows.forEach(r => ws.addRow(r));
      });
    }
    return proj;
  }
  return { tmpDir, setupProject };
}

/**
 * 拦截 process.stdout.write，返回拼接后的字符串
 * @param {() => Promise<void> | void} fn
 * @returns {Promise<string>}
 */
function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = origWrite;
  }).then(() => chunks.join(''));
}

module.exports = { createTmpProjectFactory, captureStdout };
