'use strict';

const { add } = require('../lib/registry.cjs');

module.exports = async function dashboardRegister(projectRoot, _args) {
  if (!projectRoot) throw new Error('dashboard-register 需要 <project-root> 参数');
  const entry = add(projectRoot);
  process.stdout.write(JSON.stringify(entry) + '\n');
};
