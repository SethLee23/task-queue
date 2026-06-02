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

function makeDeps(overrides = {}) {
  const tmuxCalls = [];
  const pushes = [];
  let savedState = overrides.state || {};
  return {
    tmuxCalls, pushes, getState: () => savedState,
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
      log: () => {},
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
