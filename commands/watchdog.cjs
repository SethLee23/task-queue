'use strict';

const { execFileSync: realExecFileSync } = require('node:child_process');
const registry = require('../lib/registry.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { readPaused } = require('../lib/paused.cjs');
const { readState, writeState } = require('../lib/watchdog-state.cjs');
const { sessionName, launchHeadless } = require('../lib/launch-command.cjs');
const testPushCmd = require('./test-push.cjs');

const STALE_MS = 30 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;
const WATCHDOG_LABEL = 'com.taskqueue.watchdog';

const EMPTY = () => ({ consecutive: 0, lastRestartAt: null, gaveUp: false });

/**
 * 单项目决策（纯函数）。
 * @returns {{decision:'ignore'|'reset'|'skip'|'restart'|'giveup', reason?:string}}
 */
function decideProject({ now, hidden, hb, paused, st }) {
  if (hidden) return { decision: 'ignore' };
  const age = hb && hb.ts ? Date.parse(hb.ts) : NaN;
  if (!Number.isNaN(age) && (now - age) <= STALE_MS) return { decision: 'reset' };
  if (paused) return { decision: 'skip', reason: 'paused' };
  if (!hb || !hb.ts) return { decision: 'skip', reason: 'never-ran' };
  if (Number.isNaN(age)) return { decision: 'skip', reason: 'bad-ts' };
  if (hb.phase === 'executing') return { decision: 'skip', reason: 'executing' };
  if (st.gaveUp) return { decision: 'skip', reason: 'gave-up' };
  if (st.lastRestartAt && (now - st.lastRestartAt) < GRACE_MS) return { decision: 'skip', reason: 'grace' };
  if (st.consecutive >= MAX_RESTARTS) return { decision: 'giveup' };
  return { decision: 'restart' };
}

/**
 * 跑一遍扫描。所有副作用走注入 deps，便于单测。
 * @param {object} deps
 */
async function runPass(deps) {
  const {
    now = Date.now(),
    registryList = registry.list,
    readHeartbeat: readHb = readHeartbeat,
    readPaused: readPausedFn = readPaused,
    readState: readSt = readState,
    writeState: writeSt = writeState,
    execFileSyncImpl = realExecFileSync,
    launchHeadless: launch = launchHeadless,
    testPush = (msg) => testPushCmd(msg, ['--title', 'task-queue 看门狗']),
    log = (m) => process.stdout.write(m + '\n'),
  } = deps;

  const state = readSt();
  const projects = registryList();

  for (const entry of projects) {
    try {
      const st = state[entry.slug] || EMPTY();
      const hb = readHb(entry.root);
      const paused = readPausedFn(entry.root);
      const { decision, reason } = decideProject({ now, hidden: entry.hidden, hb, paused, st });

      if (decision === 'ignore') continue;
      if (decision === 'skip') { log(`[skip] ${entry.slug} (${reason})`); continue; }

      if (decision === 'reset') {
        if (state[entry.slug] && (st.consecutive || st.gaveUp || st.lastRestartAt)) {
          state[entry.slug] = EMPTY();
          writeSt(state);
        }
        continue;
      }

      if (decision === 'giveup') {
        state[entry.slug] = { ...st, gaveUp: true };
        writeSt(state);
        log(`[giveup] ${entry.slug} 连续 ${MAX_RESTARTS} 次重启失败，放弃`);
        await testPush(`看门狗：${entry.slug} 连续 ${MAX_RESTARTS} 次重启仍未恢复心跳，已放弃，请手动检查`);
        continue;
      }

      if (decision === 'restart') {
        const session = sessionName(entry.slug);
        state[entry.slug] = { ...st, consecutive: st.consecutive + 1, lastRestartAt: now, gaveUp: false };
        writeSt(state);
        log(`[restart] ${entry.slug} 第 ${st.consecutive + 1} 次重启`);
        try { execFileSyncImpl('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch (_) {}
        launch(entry.root, entry.slug, execFileSyncImpl);
      }
    } catch (err) {
      log(`[error] ${entry.slug}: ${err.message}`);
    }
  }
}

module.exports = { decideProject, runPass, STALE_MS, GRACE_MS, MAX_RESTARTS, WATCHDOG_LABEL };
