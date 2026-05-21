'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rootToSlug } = require('../lib/slug.cjs');

test('普通路径取末段并 lowercase', () => {
  assert.equal(rootToSlug('/Users/seth/Desktop/para-node-4.0'), 'para-node-4-0');
});

test('末段含非字母数字字符 → 替换为 -', () => {
  assert.equal(rootToSlug('/tmp/my proj@v2!'), 'my-proj-v2');
});

test('连续非字母数字字符合并为单个 -', () => {
  assert.equal(rootToSlug('/tmp/a___b---c'), 'a-b-c');
});

test('首尾 - 被剥除', () => {
  assert.equal(rootToSlug('/tmp/--abc--'), 'abc');
});

test('全非法字符 fallback 到 "project"', () => {
  assert.equal(rootToSlug('/tmp/!!!'), 'project');
});
