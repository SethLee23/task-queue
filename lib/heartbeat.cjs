'use strict';

const fs = require('node:fs');
const path = require('node:path');

function heartbeatPath(projectRoot) {
  return path.join(projectRoot, '.tasks', 'run', 'heartbeat.json');
}

/**
 * 决定本次写入的任务 id 数组。优先级:
 * patch.currentTaskIds(显式数组)> patch.currentTaskId(单值,null=清空)> prev 继承。
 */
function resolveIds(patch, prev) {
  if (Array.isArray(patch.currentTaskIds)) return patch.currentTaskIds.filter(v => v != null);
  if (Object.prototype.hasOwnProperty.call(patch, 'currentTaskId')) {
    return patch.currentTaskId == null ? [] : [patch.currentTaskId];
  }
  if (Array.isArray(prev.currentTaskIds)) return prev.currentTaskIds.filter(v => v != null);
  if (prev.currentTaskId != null) return [prev.currentTaskId];
  return [];
}

function readHeartbeat(projectRoot) {
  const p = heartbeatPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw.currentTaskIds)) {
      raw.currentTaskIds = raw.currentTaskId != null ? [raw.currentTaskId] : [];
    }
    return raw;
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
    const ids = resolveIds(patch, prev);
    const next = {
      ...prev,
      ...patch,
      ts: new Date().toISOString(),
      model: patch.model || process.env.CLAUDE_MODEL || prev.model || 'unknown',
      currentTaskIds: ids,
      currentTaskId: ids.length ? ids[0] : null,
    };
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { writeHeartbeat, readHeartbeat, heartbeatPath };
