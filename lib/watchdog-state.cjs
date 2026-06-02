'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function statePath() {
  return process.env.TASK_QUEUE_WATCHDOG_STATE_PATH
    || path.join(os.homedir(), '.task-queue', 'watchdog-state.json');
}

/** 读状态；文件缺失或损坏均返回空对象。 */
function readState() {
  const p = statePath();
  if (!fs.existsSync(p)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

/** 落盘状态（best-effort 建目录）。 */
function writeState(state) {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
}

module.exports = { readState, writeState, statePath };
