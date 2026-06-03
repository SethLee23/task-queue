'use strict';
const { createForTask } = require('../lib/worktree.cjs');

/** 主 loop 调:为任务建 worktree(替代裸跑 git,保证 symlink/分支约定一致) */
module.exports = async function worktreeCreate(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('worktree-create 需要 id 参数');
  const r = createForTask(projectRoot, idArg);
  process.stdout.write(JSON.stringify(r) + '\n');
};
