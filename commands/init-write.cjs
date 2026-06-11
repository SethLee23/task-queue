// commands/init-write.cjs — 将 Claude 收集到的 answers 落盘（核心逻辑在 lib/init-core.cjs）
'use strict';

const { initCore } = require('../lib/init-core.cjs');

/**
 * init-write 命令 CLI 入口：解析 answers JSON → initCore → stdout 输出结果 JSON。
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} args args[0] 为 answers JSON 字符串
 * @returns {Promise<void>}
 */
module.exports = async function initWrite(projectRoot, args) {
  const answersJsonRaw = args[0];
  if (!answersJsonRaw) throw new Error('init-write 需要 <answers-json> 参数');

  let answers;
  try {
    answers = JSON.parse(answersJsonRaw);
  } catch (e) {
    throw new Error(`answers-json 解析失败: ${e.message}`);
  }

  const result = await initCore(projectRoot, answers);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
};
