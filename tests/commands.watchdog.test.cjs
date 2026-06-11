'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wd = require('../commands/watchdog.cjs');
const { decideProject, runPass, STALE_MS, GRACE_MS, MAX_RESTARTS } = wd;

const NOW = 1_000_000_000_000;
const stale = (ms) => new Date(NOW - ms).toISOString();
const freshHb = { phase: 'idle', ts: stale(60 * 1000) };
const staleIdleHb = { phase: 'idle', ts: stale(STALE_MS + 1000) };
const staleExecHb = { phase: 'executing', ts: stale(STALE_MS + 1000) };
const emptyState = { consecutive: 0, lastRestartAt: null, gaveUp: false };

test('hidden → ignore', () => {
  assert.equal(decideProject({ now: NOW, hidden: true, hb: staleIdleHb, paused: null, st: emptyState }).decision, 'ignore');
});
test('心跳新鲜 → reset', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: freshHb, paused: null, st: { consecutive: 2, lastRestartAt: NOW, gaveUp: true } }).decision, 'reset');
});
test('陈旧 idle 未暂停有 hb → restart', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st: emptyState }).decision, 'restart');
});
test('陈旧但 executing → skip', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleExecHb, paused: null, st: emptyState }).decision, 'skip');
});
test('陈旧但 paused → skip', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: '手动', st: emptyState }).decision, 'skip');
});
test('无 heartbeat → skip（不冷启）', () => {
  assert.equal(decideProject({ now: NOW, hidden: false, hb: null, paused: null, st: emptyState }).decision, 'skip');
});
test('grace 窗口内 → skip', () => {
  const st = { consecutive: 1, lastRestartAt: NOW - (GRACE_MS - 1000), gaveUp: false };
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st }).decision, 'skip');
});
test('grace 后仍陈旧 → restart', () => {
  const st = { consecutive: 1, lastRestartAt: NOW - (GRACE_MS + 1000), gaveUp: false };
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st }).decision, 'restart');
});
test('consecutive 达上限 → giveup', () => {
  const st = { consecutive: MAX_RESTARTS, lastRestartAt: NOW - (GRACE_MS + 1000), gaveUp: false };
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st }).decision, 'giveup');
});
test('已 gaveUp → skip', () => {
  const st = { consecutive: MAX_RESTARTS, lastRestartAt: NOW - (GRACE_MS + 1000), gaveUp: true };
  assert.equal(decideProject({ now: NOW, hidden: false, hb: staleIdleHb, paused: null, st }).decision, 'skip');
});

test('心跳 ts 损坏 → skip(bad-ts)，不重启', () => {
  const badHb = { phase: 'idle', ts: 'not-a-date' };
  const r = decideProject({ now: NOW, hidden: false, hb: badHb, paused: null, st: emptyState });
  assert.equal(r.decision, 'skip');
  assert.equal(r.reason, 'bad-ts');
});

// ---- 主动上下文重置（proactive-context-reset）----
// 心跳新鲜但本会话轮数(rounds)超阈值 → 在 loop 撑死前主动重启,把上下文从地板重来。
const freshRounds = (rounds, phase = 'idle') => ({ phase, ts: stale(60 * 1000), rounds });

test('proactive：新鲜 idle + rounds 达阈值 → restart(proactive-context-reset)', () => {
  const r = decideProject({ now: NOW, hidden: false, hb: freshRounds(40), paused: null, st: emptyState, maxRounds: 40 });
  assert.equal(r.decision, 'restart');
  assert.equal(r.reason, 'proactive-context-reset');
});
test('proactive：新鲜但 executing + rounds 超阈值 → reset(不打断在飞任务)', () => {
  const r = decideProject({ now: NOW, hidden: false, hb: freshRounds(99, 'executing'), paused: null, st: emptyState, maxRounds: 40 });
  assert.equal(r.decision, 'reset');
});
test('proactive：新鲜但 paused + rounds 超阈值 → reset(暂停中不碰)', () => {
  const r = decideProject({ now: NOW, hidden: false, hb: freshRounds(99), paused: '手动', st: emptyState, maxRounds: 40 });
  assert.equal(r.decision, 'reset');
});
test('proactive：新鲜 + rounds 未达阈值 → reset', () => {
  const r = decideProject({ now: NOW, hidden: false, hb: freshRounds(39), paused: null, st: emptyState, maxRounds: 40 });
  assert.equal(r.decision, 'reset');
});
test('proactive：maxRounds 缺省时用默认 MAX_ROUNDS(40)', () => {
  assert.equal(wd.MAX_ROUNDS, 40, '默认阈值应为 40');
  const r = decideProject({ now: NOW, hidden: false, hb: freshRounds(40), paused: null, st: emptyState });
  assert.equal(r.decision, 'restart');
  assert.equal(r.reason, 'proactive-context-reset');
});
test('proactive：无 rounds 字段的新鲜心跳 → reset(向后兼容老心跳文件)', () => {
  const r = decideProject({ now: NOW, hidden: false, hb: { phase: 'idle', ts: stale(60 * 1000) }, paused: null, st: emptyState, maxRounds: 40 });
  assert.equal(r.decision, 'reset');
});

function makeDeps(overrides = {}) {
  const tmuxCalls = [];
  const pushes = [];
  const logs = [];
  let savedState = overrides.state || {};
  return {
    tmuxCalls, pushes, logs, getState: () => savedState,
    deps: {
      now: NOW,
      registryList: () => overrides.projects || [],
      readHeartbeat: (root) => (overrides.hb || {})[root] ?? null,
      readPaused: (root) => (overrides.paused || {})[root] ?? null,
      readState: () => savedState,
      writeState: (s) => { savedState = s; },
      execFileSyncImpl: (bin, args) => { tmuxCalls.push([bin, ...args].join(' ')); },
      launchHeadless: (root, slug, exec) => { exec('tmux', ['new-session', '-ds', `task-queue-loop-${slug}`]); return `task-queue-loop-${slug}`; },
      testPush: async (msg) => { pushes.push(msg); },
      maxRoundsFor: (root) => (overrides.maxRounds || {})[root] ?? wd.MAX_ROUNDS,
      log: (m) => { logs.push(m); },
    },
  };
}

test('runPass：陈旧 idle 项目被重启，consecutive→1', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: false };
  const h = makeDeps({ projects: [proj], hb: { '/p/demo': staleIdleHb }, paused: {}, state: {} });
  await runPass(h.deps);
  assert.ok(h.tmuxCalls.some(c => c.includes('kill-session') && c.includes('task-queue-loop-demo')), '应先 kill-session');
  assert.ok(h.tmuxCalls.some(c => c.includes('new-session') && c.includes('task-queue-loop-demo')), '应 new-session 重启');
  assert.equal(h.getState().demo.consecutive, 1);
  assert.equal(typeof h.getState().demo.lastRestartAt, 'number');
});
test('runPass：consecutive 达上限 → 不重启、置 gaveUp、发桌面告警', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: false };
  const st = { demo: { consecutive: MAX_RESTARTS, lastRestartAt: NOW - (GRACE_MS + 1), gaveUp: false } };
  const h = makeDeps({ projects: [proj], hb: { '/p/demo': staleIdleHb }, paused: {}, state: st });
  await runPass(h.deps);
  assert.ok(!h.tmuxCalls.some(c => c.includes('new-session')), '放弃时不应再 new-session');
  assert.equal(h.getState().demo.gaveUp, true);
  assert.equal(h.pushes.length, 1, '应发一条桌面告警');
  assert.ok(h.pushes[0].includes('demo'), '告警含 slug');
});
test('runPass：心跳新鲜 → 复位退避状态', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: false };
  const st = { demo: { consecutive: 2, lastRestartAt: NOW, gaveUp: true } };
  const h = makeDeps({ projects: [proj], hb: { '/p/demo': freshHb }, paused: {}, state: st });
  await runPass(h.deps);
  assert.deepEqual(h.getState().demo, { consecutive: 0, lastRestartAt: null, gaveUp: false });
  assert.ok(!h.tmuxCalls.some(c => c.includes('new-session')));
});
test('runPass：hidden 项目完全忽略', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: true };
  const h = makeDeps({ projects: [proj], hb: { '/p/demo': staleIdleHb }, paused: {}, state: {} });
  await runPass(h.deps);
  assert.equal(h.tmuxCalls.length, 0);
  assert.deepEqual(h.getState(), {});
});

test('runPass：心跳新鲜 + rounds 超阈值 → 主动重启并日志标注 proactive-context-reset', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: false };
  const hb = { '/p/demo': { phase: 'idle', ts: stale(60 * 1000), rounds: 50 } };
  const h = makeDeps({ projects: [proj], hb, paused: {}, state: {}, maxRounds: { '/p/demo': 40 } });
  await runPass(h.deps);
  assert.ok(h.tmuxCalls.some(c => c.includes('kill-session') && c.includes('task-queue-loop-demo')), '应先 kill 旧会话');
  assert.ok(h.tmuxCalls.some(c => c.includes('new-session') && c.includes('task-queue-loop-demo')), '应主动重启');
  assert.ok(h.logs.some(l => l.includes('proactive-context-reset')), '日志应标注主动重置原因');
});

test('runPass：maxRounds 被项目配置上调,rounds 未达阈值 → 不重启', async () => {
  const proj = { slug: 'demo', root: '/p/demo', hidden: false };
  const hb = { '/p/demo': { phase: 'idle', ts: stale(60 * 1000), rounds: 50 } };
  const h = makeDeps({ projects: [proj], hb, paused: {}, state: {}, maxRounds: { '/p/demo': 100 } });
  await runPass(h.deps);
  assert.ok(!h.tmuxCalls.some(c => c.includes('new-session')), 'rounds 50 < 阈值 100,不应重启');
});

test('renderPlist 含 Label / StartInterval 60 / RunAtLoad / PATH / ProgramArguments', () => {
  const xml = wd.renderPlist({
    nodePath: '/opt/homebrew/bin/node',
    tasksCjs: '/Users/x/.claude/skills/task-queue/tasks.cjs',
    pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
    logPath: '/Users/x/.task-queue/watchdog.log',
  });
  assert.ok(xml.includes('<string>com.taskqueue.watchdog</string>'), '含 Label');
  assert.ok(xml.includes('<key>StartInterval</key>'));
  assert.ok(xml.includes('<integer>60</integer>'), 'StartInterval 60');
  assert.ok(xml.includes('<key>RunAtLoad</key>'));
  assert.ok(xml.includes('<true/>'));
  assert.ok(xml.includes('<string>/opt/homebrew/bin/node</string>'));
  assert.ok(xml.includes('<string>/Users/x/.claude/skills/task-queue/tasks.cjs</string>'));
  assert.ok(xml.includes('<string>watchdog</string>'));
  assert.ok(xml.includes('/opt/homebrew/bin:/usr/bin:/bin'), '含 PATH env');
  assert.ok(xml.includes('<string>/Users/x/.task-queue/watchdog.log</string>'), '含日志路径');
});
