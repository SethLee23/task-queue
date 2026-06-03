'use strict';
const { listOrphans } = require('../lib/worktree.cjs');

module.exports = async function worktreeList(projectRoot, _args) {
  process.stdout.write(JSON.stringify({ worktrees: listOrphans(projectRoot) }) + '\n');
};
