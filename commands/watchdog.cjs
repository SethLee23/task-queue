'use strict';

const { execFileSync: realExecFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const registry = require('../lib/registry.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { readPaused } = require('../lib/paused.cjs');
const { readState, writeState } = require('../lib/watchdog-state.cjs');
const { sessionName, launchHeadless } = require('../lib/launch-command.cjs');
const { loadProjectConfig, getMaxRounds } = require('../lib/config.cjs');
const testPushCmd = require('./test-push.cjs');

const STALE_MS = 30 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;
const MAX_ROUNDS = 40;
const WATCHDOG_LABEL = 'com.taskqueue.watchdog';

const EMPTY = () => ({ consecutive: 0, lastRestartAt: null, gaveUp: false });

/**
 * 单项目决策（纯函数）。
 * @param {object} p
 * @param {number} [p.maxRounds] 主动上下文重置阈值（本会话轮数 ≥ 此值且健康空闲时主动重启）。默认 MAX_ROUNDS。
 * @returns {{decision:'ignore'|'reset'|'skip'|'restart'|'giveup', reason?:string}}
 */
function decideProject({ now, hidden, hb, paused, st, maxRounds = MAX_ROUNDS }) {
  if (hidden) return { decision: 'ignore' };
  const age = hb && hb.ts ? Date.parse(hb.ts) : NaN;
  if (!Number.isNaN(age) && (now - age) <= STALE_MS) {
    // 心跳新鲜 = loop 健康。被动重启不触发；但若本会话轮数超阈值,在 loop 撑死/
    // 上下文拖垮成本之前主动重启,把上下文从 50k 地板重来。复用既有安全闸:
    // executing 不打断、paused 不碰 —— 仅在两轮之间的健康空窗重置。
    if (paused || hb.phase === 'executing') return { decision: 'reset' };
    if ((hb.rounds || 0) >= maxRounds) return { decision: 'restart', reason: 'proactive-context-reset' };
    return { decision: 'reset' };
  }
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
    // 每项目主动重置阈值:读 project.config.js 的 maxRounds(缺省/异常兜底 MAX_ROUNDS)。
    maxRoundsFor = (root) => { try { return getMaxRounds(loadProjectConfig(root)); } catch (_) { return MAX_ROUNDS; } },
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
      const maxRounds = maxRoundsFor(entry.root);
      const { decision, reason } = decideProject({ now, hidden: entry.hidden, hb, paused, st, maxRounds });

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
        log(`[restart] ${entry.slug} ${reason ? reason : `第 ${st.consecutive + 1} 次重启`}`);
        try { execFileSyncImpl('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch (_) {}
        launch(entry.root, entry.slug, execFileSyncImpl);
      }
    } catch (err) {
      log(`[error] ${entry.slug}: ${err.message}`);
    }
  }
}

/** which：返回绝对路径或 null。 */
function which(bin, execFileSyncImpl = realExecFileSync) {
  try {
    return execFileSyncImpl('/usr/bin/which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch (_) { return null; }
}

/** 渲染 launchd plist XML。 */
function renderPlist({ nodePath, tasksCjs, pathEnv, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${tasksCjs}</string>
    <string>watchdog</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
}

async function doInstall() {
  const nodePath = process.execPath;
  const tasksCjs = path.resolve(__dirname, '..', 'tasks.cjs');
  const tmux = which('tmux');
  const claude = which('claude');
  if (!tmux) throw new Error('PATH 中找不到 tmux，请先安装（brew install tmux）');
  if (!claude) throw new Error('PATH 中找不到 claude');
  const dirs = [path.dirname(nodePath), path.dirname(tmux), path.dirname(claude), '/usr/bin', '/bin'];
  const pathEnv = [...new Set(dirs)].join(':');
  const logPath = path.join(os.homedir(), '.task-queue', 'watchdog.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const xml = renderPlist({ nodePath, tasksCjs, pathEnv, logPath });
  const pl = plistPath();
  fs.mkdirSync(path.dirname(pl), { recursive: true });
  fs.writeFileSync(pl, xml);
  try { realExecFileSync('launchctl', ['unload', pl], { stdio: 'ignore' }); } catch (_) {}
  realExecFileSync('launchctl', ['load', '-w', pl], { stdio: 'inherit' });
  process.stdout.write(JSON.stringify({ ok: true, action: 'install', plist: pl, pathEnv }) + '\n');
}

async function doUninstall() {
  const pl = plistPath();
  try { realExecFileSync('launchctl', ['unload', pl], { stdio: 'ignore' }); } catch (_) {}
  try { fs.unlinkSync(pl); } catch (_) {}
  process.stdout.write(JSON.stringify({ ok: true, action: 'uninstall', plist: pl }) + '\n');
}

async function doStatus() {
  let loaded = false;
  try { realExecFileSync('launchctl', ['list', WATCHDOG_LABEL], { stdio: 'ignore' }); loaded = true; } catch (_) {}
  process.stdout.write(JSON.stringify({ ok: true, loaded, plist: plistPath(), state: readState() }, null, 2) + '\n');
}

/** dispatcher 入口：argv[3] 作为子动作（watchdog 不需 project-root）。 */
async function handler(subAction) {
  switch (subAction) {
    case 'install': return doInstall();
    case 'uninstall': return doUninstall();
    case 'status': return doStatus();
    case undefined:
    case 'run': return runPass({});
    default: throw new Error(`未知 watchdog 子动作: ${subAction}（可选: run/install/uninstall/status）`);
  }
}

module.exports = handler;
module.exports.decideProject = decideProject;
module.exports.runPass = runPass;
module.exports.renderPlist = renderPlist;
module.exports.STALE_MS = STALE_MS;
module.exports.GRACE_MS = GRACE_MS;
module.exports.MAX_RESTARTS = MAX_RESTARTS;
module.exports.MAX_ROUNDS = MAX_ROUNDS;
module.exports.WATCHDOG_LABEL = WATCHDOG_LABEL;
