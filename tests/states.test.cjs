const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STATES, IN_PROGRESS_SHEET_STATES, ARCHIVED_SHEET_STATES, canTransition, normalizePriority, PRIORITY_ORDER } = require('../lib/states.cjs');

test('STATES 包含全部 6 个状态', () => {
  assert.equal(STATES.TODO, '待办');
  assert.equal(STATES.IN_PROGRESS, '进行中');
  assert.equal(STATES.DONE, '已完成');
  assert.equal(STATES.REVIEW, '已完成-待review');
  assert.equal(STATES.BLOCKED, '阻塞-等答疑');
  assert.equal(STATES.SKIPPED, '跳过');
});

test('IN_PROGRESS_SHEET_STATES 含 4 个、ARCHIVED 含 2 个', () => {
  assert.deepEqual(IN_PROGRESS_SHEET_STATES.sort(), ['进行中', '待办', '已完成-待review', '阻塞-等答疑'].sort());
  assert.deepEqual(ARCHIVED_SHEET_STATES.sort(), ['已完成', '跳过'].sort());
});

test('canTransition 合法转换返回 true', () => {
  assert.equal(canTransition('待办', '进行中'), true);
  assert.equal(canTransition('进行中', '已完成'), true);
  assert.equal(canTransition('进行中', '已完成-待review'), true);
  assert.equal(canTransition('进行中', '阻塞-等答疑'), true);
  assert.equal(canTransition('已完成-待review', '已完成'), true);
  assert.equal(canTransition('已完成-待review', '跳过'), true);
  assert.equal(canTransition('阻塞-等答疑', '待办'), true);
  assert.equal(canTransition('进行中', '待办'), true); // recover 用
});

test('canTransition 非法转换返回 false', () => {
  assert.equal(canTransition('待办', '已完成'), false); // 必须先 claim
  assert.equal(canTransition('已完成', '待办'), false); // 已归档不能回退
  assert.equal(canTransition('跳过', '待办'), false);
});

test('normalizePriority 把中文转数字（用于排序）', () => {
  assert.equal(normalizePriority('高'), 1);
  assert.equal(normalizePriority('中'), 2);
  assert.equal(normalizePriority('低'), 3);
  assert.equal(normalizePriority(''), 4); // 缺省排最后
  assert.equal(normalizePriority('未知'), 4);
});

test('PRIORITY_ORDER 是数组', () => {
  assert.deepEqual(PRIORITY_ORDER, ['高', '中', '低']);
});
