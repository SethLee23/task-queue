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
    // rounds = 当前会话的唤醒轮数。resetRounds（新会话起步）归零，
    // incrementRound（每轮 Step 0.1 的 heartbeat 命令）+1；二者都是控制位，不落盘。
    const { resetRounds, incrementRound, stopped: stoppedPatch, ...rest } = patch;
    let rounds = typeof prev.rounds === 'number' ? prev.rounds : 0;
    if (resetRounds) rounds = 0;
    else if (incrementRound) rounds += 1;
    // stopped = 面板"停 loop"显式置位，让 deriveOnline 立即判离线（不等心跳过期）。
    // 任何唤醒（incrementRound）或启动（resetRounds）都说明 loop 又活了 → 清除。
    let stopped = prev.stopped === true;
    if (resetRounds || incrementRound) stopped = false;
    if (stoppedPatch === true) stopped = true;
    else if (stoppedPatch === false) stopped = false;
    const next = {
      ...prev,
      ...rest,
      ts: new Date().toISOString(),
      model: rest.model || process.env.CLAUDE_MODEL || prev.model || 'unknown',
      currentTaskIds: ids,
      currentTaskId: ids.length ? ids[0] : null,
      rounds,
      stopped,
    };
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { writeHeartbeat, readHeartbeat, heartbeatPath };
