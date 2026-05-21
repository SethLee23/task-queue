'use strict';

const fs = require('node:fs');
const path = require('node:path');

function wakeNowPath(projectRoot) {
  return path.join(projectRoot, '.tasks', 'run', 'wake-now');
}

function setWakeNow(projectRoot, reason) {
  const p = wakeNowPath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(reason ?? ''));
}

function clearWakeNow(projectRoot) {
  try { fs.unlinkSync(wakeNowPath(projectRoot)); } catch (_) {}
}

function readWakeNow(projectRoot) {
  const p = wakeNowPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

module.exports = { setWakeNow, clearWakeNow, readWakeNow, wakeNowPath };
