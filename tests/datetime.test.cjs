const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localDateStr, localTimeStr } = require('../lib/datetime.cjs');

test('localDateStr 返回符合 YYYY-MM-DD 格式的字符串', () => {
  const result = localDateStr();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('localTimeStr 返回符合 HH:MM:SS 格式的字符串', () => {
  const result = localTimeStr();
  assert.match(result, /^\d{2}:\d{2}:\d{2}$/);
});
