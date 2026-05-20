'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sortByPriorityAndCtime } = require('../lib/sort.cjs');

test('sortByPriorityAndCtime 高 < 中 < 低', () => {
  const rows = [
    { priority: '低', ctime: '2026-05-20T10:00:00Z' },
    { priority: '高', ctime: '2026-05-20T11:00:00Z' },
    { priority: '中', ctime: '2026-05-20T09:00:00Z' },
  ];
  sortByPriorityAndCtime(rows);
  assert.deepEqual(rows.map(r => r.priority), ['高', '中', '低']);
});

test('sortByPriorityAndCtime 同优先级按 ctime 升序', () => {
  const rows = [
    { priority: '高', ctime: '2026-05-20T12:00:00Z' },
    { priority: '高', ctime: '2026-05-20T10:00:00Z' },
  ];
  sortByPriorityAndCtime(rows);
  assert.equal(rows[0].ctime, '2026-05-20T10:00:00Z');
});

test('sortByPriorityAndCtime 空 ctime 不抛错', () => {
  const rows = [
    { priority: '高', ctime: '' },
    { priority: '高', ctime: '2026-05-20T10:00:00Z' },
  ];
  sortByPriorityAndCtime(rows);
  assert.equal(rows[0].ctime, ''); // '' < '2026-...' 字典序
});
