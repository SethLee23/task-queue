'use strict';

const fs = require('node:fs');
const path = require('node:path');

function heartbeatPath(projectRoot) {
  return path.join(projectRoot, '.tasks', 'run', 'heartbeat.json');
}

function readHeartbeat(projectRoot) {
  const p = heartbeatPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeHeartbeat(projectRoot, patch) {
  const p = heartbeatPath(projectRoot);
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const prev = readHeartbeat(projectRoot) || {};
    const next = {
      ...prev,
      ...patch,
      ts: new Date().toISOString(),
      model: patch.model || process.env.CLAUDE_MODEL || prev.model || 'unknown',
    };
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { writeHeartbeat, readHeartbeat, heartbeatPath };
