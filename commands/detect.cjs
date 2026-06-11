// commands/detect.cjs — 静态分析项目结构，输出 JSON 配置建议（核心逻辑在 lib/detect-core.cjs）
'use strict';

const { detectCore } = require('../lib/detect-core.cjs');

/**
 * detect 命令 CLI 入口。projectRoot 为空时默认 process.cwd()。
 * @param {string|undefined} projectRoot 项目根目录路径
 * @param {string[]} _args 剩余参数（暂未使用）
 * @returns {Promise<void>}
 */
module.exports = async function detect(projectRoot, _args) {
  if (!projectRoot) projectRoot = process.cwd();
  const result = detectCore(projectRoot);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
};
