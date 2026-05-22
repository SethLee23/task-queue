// commands/set-desired-model.cjs — 设置项目级 desiredModel（subagent 派发用）
'use strict';

const { update, list, VALID_MODELS } = require('../lib/registry.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * 按 projectRoot 找到对应 slug 后更新 desiredModel。
 * @param {string} projectRoot
 * @param {string} model 'opus' | 'sonnet' | 'haiku'
 * @returns {{ slug: string, desiredModel: string }}
 */
function setDesiredModelCore(projectRoot, model) {
  if (!VALID_MODELS.includes(model)) {
    throw new Error(`不支持的模型: ${model}（可选: ${VALID_MODELS.join('/')}）`);
  }
  const entry = list().find(p => p.root === projectRoot);
  if (!entry) throw new Error(`registry 中未找到项目: ${projectRoot}`);
  const updated = update(entry.slug, { desiredModel: model });
  new Logger(projectRoot).info(`set desiredModel → ${model}`);
  return { slug: updated.slug, desiredModel: updated.desiredModel };
}

/**
 * CLI 入口：args = [model]
 * @param {string} projectRoot
 * @param {string[]} args
 */
async function cli(projectRoot, args) {
  const [model] = args;
  const result = setDesiredModelCore(projectRoot, model);
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = cli;
module.exports.setDesiredModelCore = setDesiredModelCore;
