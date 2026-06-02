// commands/set-hidden.cjs — 设置项目级 hidden（dashboard 左侧列表隐藏/显示）
'use strict';

const { update, list } = require('../lib/registry.cjs');
const { Logger } = require('../lib/logger.cjs');

/**
 * 按 projectRoot 找到对应 slug 后更新 hidden。
 * @param {string} projectRoot
 * @param {boolean} hidden
 * @returns {{ slug: string, hidden: boolean }}
 */
function setHiddenCore(projectRoot, hidden) {
  if (typeof hidden !== 'boolean') {
    throw new Error(`hidden 必须是 boolean: ${hidden}`);
  }
  const entry = list().find(p => p.root === projectRoot);
  if (!entry) throw new Error(`registry 中未找到项目: ${projectRoot}`);
  const updated = update(entry.slug, { hidden });
  new Logger(projectRoot).info(`set hidden → ${hidden}`);
  return { slug: updated.slug, hidden: updated.hidden };
}

/**
 * 按 slug 直接更新（dashboard REST 入口用）。
 * @param {string} slug
 * @param {boolean} hidden
 * @returns {object} normalized entry
 */
function setHiddenBySlug(slug, hidden) {
  if (typeof hidden !== 'boolean') {
    throw new Error(`hidden 必须是 boolean: ${hidden}`);
  }
  return update(slug, { hidden });
}

/**
 * CLI 入口：args = [hidden]（"true"/"false"/"1"/"0"）
 * @param {string} projectRoot
 * @param {string[]} args
 */
async function cli(projectRoot, args) {
  const [arg] = args;
  if (arg !== 'true' && arg !== 'false' && arg !== '1' && arg !== '0') {
    throw new Error(`hidden 参数必须是 true/false: ${arg}`);
  }
  const hidden = arg === 'true' || arg === '1';
  const result = setHiddenCore(projectRoot, hidden);
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = cli;
module.exports.setHiddenCore = setHiddenCore;
module.exports.setHiddenBySlug = setHiddenBySlug;
