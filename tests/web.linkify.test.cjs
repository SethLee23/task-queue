'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findLinks, linkify } = require('../web/linkify.js');

function texts(matches) { return matches.map(m => m.text); }

test('findLinks: 空 / 非字符串 → []', () => {
  assert.deepEqual(findLinks(''), []);
  assert.deepEqual(findLinks(null), []);
  assert.deepEqual(findLinks(undefined), []);
});

test('findLinks: 纯文本无路径 → []', () => {
  assert.deepEqual(findLinks('改 ReqConfig label 中文'), []);
  assert.deepEqual(findLinks('plain word foo'), []);
});

test('findLinks: 单个 https URL', () => {
  const out = findLinks('see https://example.com/foo for details');
  assert.deepEqual(texts(out), ['https://example.com/foo']);
});

test('findLinks: URL 末尾标点剥除', () => {
  assert.deepEqual(texts(findLinks('go to https://example.com/foo.')), ['https://example.com/foo']);
  assert.deepEqual(texts(findLinks('"https://example.com/foo"')), ['https://example.com/foo']);
  assert.deepEqual(texts(findLinks('(https://example.com/foo)')), ['https://example.com/foo']);
  assert.deepEqual(texts(findLinks('看 https://example.com 然后')), ['https://example.com']);
});

test('findLinks: URL 路径含 query/hash', () => {
  assert.deepEqual(texts(findLinks('https://example.com/a?x=1&y=2#hash')), ['https://example.com/a?x=1&y=2#hash']);
});

test('findLinks: 绝对路径', () => {
  assert.deepEqual(texts(findLinks('open /Users/seth/foo.txt please')), ['/Users/seth/foo.txt']);
  assert.deepEqual(texts(findLinks('看 /tmp/foo 文件')), ['/tmp/foo']);
});

test('findLinks: 绝对路径带 :line:col', () => {
  assert.deepEqual(texts(findLinks('see /Users/x/foo.txt:42')), ['/Users/x/foo.txt:42']);
  assert.deepEqual(texts(findLinks('see /Users/x/foo.txt:42:7 line')), ['/Users/x/foo.txt:42:7']);
});

test('findLinks: ~/ 路径', () => {
  assert.deepEqual(texts(findLinks('check ~/.claude/foo.md')), ['~/.claude/foo.md']);
  assert.deepEqual(texts(findLinks('~/.bashrc')), ['~/.bashrc']);
});

test('findLinks: 相对路径多段', () => {
  assert.deepEqual(texts(findLinks('check web/src/foo.tsx file')), ['web/src/foo.tsx']);
  assert.deepEqual(texts(findLinks('a/b/c')), ['a/b/c']);
  assert.deepEqual(texts(findLinks('改了 core/src/agent.ts 热路径')), ['core/src/agent.ts']);
});

test('findLinks: 相对路径带 :line:col', () => {
  assert.deepEqual(texts(findLinks('web/src/foo.tsx:42')), ['web/src/foo.tsx:42']);
  assert.deepEqual(texts(findLinks('web/src/foo.tsx:42:7')), ['web/src/foo.tsx:42:7']);
});

test('findLinks: 单段 file.ext:line', () => {
  assert.deepEqual(texts(findLinks('see tasks.cjs:42 line')), ['tasks.cjs:42']);
  assert.deepEqual(texts(findLinks('error at app.js:100:5 here')), ['app.js:100:5']);
});

test('findLinks: 单段无 :line 不匹配（否则把所有 .ext 单词都拽进来）', () => {
  assert.deepEqual(findLinks('foo.tsx is the file'), []);
});

test('findLinks: 多个混合在一句话里', () => {
  const out = findLinks('改了 web/src/foo.tsx 和 /tmp/bar，看 https://x.com 详情');
  assert.deepEqual(texts(out), ['web/src/foo.tsx', '/tmp/bar', 'https://x.com']);
});

test('findLinks: 中文标点边界正确', () => {
  assert.deepEqual(texts(findLinks('「web/src/foo.tsx」 看这里')), ['web/src/foo.tsx']);
  assert.deepEqual(texts(findLinks('文件 /tmp/foo。后面')), ['/tmp/foo']);
});

test('findLinks: 词中间不切入', () => {
  // "abc/def" 整体被识别为 2 段相对路径（合理），但不能从 "myabc/def" 里切出 "abc/def" 子串
  const out = findLinks('abc/def');
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'abc/def');
  // 词前紧贴别的字符也算同一 token，不切出子串：
  assert.deepEqual(findLinks('Xabc/def'), [{ start: 0, end: 8, text: 'Xabc/def', kind: 'file' }]);
});

test('findLinks: kind 区分正确', () => {
  const out = findLinks('see https://x.com and /tmp/y and a/b/c');
  assert.equal(out[0].kind, 'url');
  assert.equal(out[1].kind, 'file');
  assert.equal(out[2].kind, 'file');
});

test('findLinks: start/end 正确', () => {
  const text = 'see /tmp/foo here';
  const out = findLinks(text);
  assert.equal(out.length, 1);
  assert.equal(text.slice(out[0].start, out[0].end), '/tmp/foo');
});

test('linkify: 无匹配 → 单个字符串', () => {
  assert.deepEqual(linkify('plain text', () => null), ['plain text']);
  assert.deepEqual(linkify('', () => null), ['']);
});

test('linkify: 单 URL', () => {
  const parts = linkify('see https://x.com here', m => ({ A: m.text }));
  assert.deepEqual(parts, ['see ', { A: 'https://x.com' }, ' here']);
});

test('linkify: 多个匹配', () => {
  const parts = linkify('a /tmp/x and b/c/d end', m => ({ A: m.text }));
  assert.deepEqual(parts, ['a ', { A: '/tmp/x' }, ' and ', { A: 'b/c/d' }, ' end']);
});

test('linkify: 起末尾都是链接', () => {
  const parts = linkify('/tmp/x https://y.com', m => m.text);
  // 第一个 / 紧贴开头不带前缀字符串
  assert.deepEqual(parts, ['/tmp/x', ' ', 'https://y.com']);
});
