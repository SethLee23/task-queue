'use strict';
const { destroyForTask } = require('../lib/worktree.cjs');

module.exports = async function worktreeDiscard(projectRoot, args) {
  const idArg = args[0];
  if (!idArg) throw new Error('worktree-discard 需要 id 参数');
  destroyForTask(projectRoot, idArg, { force: true, deleteBranch: true });
  process.stdout.write(JSON.stringify({ ok: true, discarded: idArg }) + '\n');
};
