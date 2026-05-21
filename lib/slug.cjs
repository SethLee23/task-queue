'use strict';

const path = require('node:path');

function rootToSlug(root) {
  const base = path.basename(String(root || ''));
  const cleaned = base.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'project';
}

module.exports = { rootToSlug };
