'use strict';

const { remove } = require('../lib/registry.cjs');

module.exports = async function dashboardUnregister(_projectRoot, args) {
  const slug = args[0];
  if (!slug) throw new Error('dashboard-unregister 需要 <slug> 参数');
  remove(slug);
  process.stdout.write(JSON.stringify({ removed: slug }) + '\n');
};
