'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeHeartbeat, readHeartbeat } = require('../lib/heartbeat.cjs');

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ids-'));
  fs.mkdirSync(path.join(dir, '.tasks', 'run'), { recursive: true });
  return dir;
}

test('写 currentTaskIds 数组 → 读回数组,且 currentTaskId 镜像为首元素', () => {
  const dir = mkRoot();
  writeHeartbeat(dir, { phase: 'executing', currentTaskIds: [7, 9] });
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, [7, 9]);
  assert.equal(hb.currentTaskId, 7);
});

test('旧调用方写单 currentTaskId → currentTaskIds 自动成 [id]', () => {
  const dir = mkRoot();
  writeHeartbeat(dir, { phase: 'executing', currentTaskId: 11 });
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, [11]);
  assert.equal(hb.currentTaskId, 11);
});

test('patch.currentTaskId=null 清空数组(done/next 的清场语义)', () => {
  const dir = mkRoot();
  writeHeartbeat(dir, { phase: 'executing', currentTaskIds: [7, 9] });
  writeHeartbeat(dir, { phase: 'idle', currentTaskId: null });
  const hb = readHeartbeat(dir);
  assert.deepEqual(hb.currentTaskIds, []);
  assert.equal(hb.currentTaskId, null);
});

test('patch 不含任务字段 → 继承 prev 数组', () => {
  const dir = mkRoot();
  writeHeartbeat(dir, { phase: 'executing', currentTaskIds: [7, 9] });
  writeHeartbeat(dir, { phase: 'executing' });
  assert.deepEqual(readHeartbeat(dir).currentTaskIds, [7, 9]);
});

test('readHeartbeat 读旧 schema 文件(只有 currentTaskId)→ 升级为数组', () => {
  const dir = mkRoot();
  fs.writeFileSync(path.join(dir, '.tasks', 'run', 'heartbeat.json'), JSON.stringify({
    phase: 'executing', currentTaskId: 5, model: 'x', ts: '2026-01-01T00:00:00Z',
  }));
  assert.deepEqual(readHeartbeat(dir).currentTaskIds, [5]);
});
