'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pausedPath(projectRoot) {
  return path.join(projectRoot, '.tasks', 'run', 'loop-paused');
}

function setPaused(projectRoot, reason) {
  const p = pausedPath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(reason ?? ''));
}

function clearPaused(projectRoot) {
  try { fs.unlinkSync(pausedPath(projectRoot)); } catch (_) {}
}

function readPaused(projectRoot) {
  const p = pausedPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

module.exports = { setPaused, clearPaused, readPaused, pausedPath };
