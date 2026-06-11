// lib/init-flow.cjs — dashboard「接入项目」编排:路径校验/探测/脚手架/init+commit
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** init 完成后 .gitignore 的提交信息（与 CLI init 流程同款） */
const INIT_COMMIT_MESSAGE = 'task-queue: 接入任务队列（ignore .tasks/）';

/**
 * 规范化用户输入路径：展开 ~、要求绝对路径、resolve 掉 ../，
 * 并拒绝文件系统根目录和 home 目录本身这类危险目标。
 * @param {string} raw 用户输入
 * @returns {string} 规范化后的绝对路径
 */
function resolveInitPath(raw) {
  let p = String(raw || '').trim();
  if (!p) throw new Error('路径不能为空');
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new Error(`需要绝对路径: ${p}`);
  p = path.resolve(p);
  if (p === path.parse(p).root) throw new Error('不允许使用文件系统根目录');
  if (p === os.homedir()) throw new Error('不允许使用 home 目录本身');
  return p;
}

/**
 * attach 模式校验：root 必须是已存在的目录。
 * @param {string} root 规范化绝对路径
 */
function validateAttachRoot(root) {
  let stat;
  try { stat = fs.statSync(root); } catch (_) { throw new Error(`目录不存在: ${root}`); }
  if (!stat.isDirectory()) throw new Error(`不是目录: ${root}`);
}

/**
 * create 模式校验：root 必须不存在，父目录必须存在。
 * @param {string} root 规范化绝对路径
 */
function validateCreateTarget(root) {
  if (fs.existsSync(root)) throw new Error(`目标已存在: ${root}（请改用「接入已有」）`);
  const parent = path.dirname(root);
  let stat;
  try { stat = fs.statSync(parent); } catch (_) { throw new Error(`父目录不存在: ${parent}`); }
  if (!stat.isDirectory()) throw new Error(`父目录不是目录: ${parent}`);
}

/**
 * 探测 root 的 git / 接入状态。
 * @param {string} root
 * @returns {{ isGitRepo: boolean, alreadyInitialized: boolean }}
 */
function inspectRoot(root) {
  return {
    isGitRepo: fs.existsSync(path.join(root, '.git')),
    alreadyInitialized: fs.existsSync(path.join(root, '.tasks', 'project.config.js')),
  };
}

module.exports = {
  INIT_COMMIT_MESSAGE,
  resolveInitPath, validateAttachRoot, validateCreateTarget, inspectRoot,
};
