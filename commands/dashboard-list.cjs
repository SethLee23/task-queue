'use strict';

const { list } = require('../lib/registry.cjs');

module.exports = async function dashboardList(_projectRoot, _args) {
  process.stdout.write(JSON.stringify({ projects: list() }) + '\n');
};
