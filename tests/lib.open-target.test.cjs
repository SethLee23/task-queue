'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTarget, buildOpenCommand, _resetVSCodeCache } = require('../lib/open-target.cjs');

test('resolveTarget: 空 / 非字符串 → 抛错', () => {
  assert.throws(() => resolveTarget(''), /必填/);
  assert.throws(() => resolveTarget('   '), /必填/);
  assert.throws(() => resolveTarget(null), /必填/);
});

test('resolveTarget: 以 - 开头 → 抛错', () => {
  assert.throws(() => resolveTarget('-rf /'), /- 开头/);
});

test('resolveTarget: http(s) URL → kind=url', () => {
  assert.deepEqual(
    resolveTarget('https://example.com/foo'),
    { kind: 'url', value: 'https://example.com/foo' },
  );
  assert.deepEqual(
    resolveTarget('http://localhost:5732'),
    { kind: 'url', value: 'http://localhost:5732' },
  );
});

test('resolveTarget: 绝对路径无后缀', () => {
  const r = resolveTarget('/Users/x/foo.txt');
  assert.equal(r.kind, 'file');
  assert.equal(r.value, '/Users/x/foo.txt');
  assert.equal(r.line, undefined);
  assert.equal(r.col, undefined);
});

test('resolveTarget: 绝对路径 + :line', () => {
  const r = resolveTarget('/Users/x/foo.txt:42');
  assert.equal(r.value, '/Users/x/foo.txt');
  assert.equal(r.line, 42);
  assert.equal(r.col, undefined);
});

test('resolveTarget: 绝对路径 + :line:col', () => {
  const r = resolveTarget('/Users/x/foo.txt:42:7');
  assert.equal(r.value, '/Users/x/foo.txt');
  assert.equal(r.line, 42);
  assert.equal(r.col, 7);
});

test('resolveTarget: ~ 展开 HOME', () => {
  const home = os.homedir();
  assert.equal(resolveTarget('~').value, home);
  assert.equal(resolveTarget('~/foo').value, path.join(home, 'foo'));
  assert.equal(resolveTarget('~/foo:10').value, path.join(home, 'foo'));
  assert.equal(resolveTarget('~/foo:10').line, 10);
});

test('resolveTarget: 相对路径需要 projectRoot', () => {
  assert.throws(() => resolveTarget('web/src/foo.tsx'), /projectRoot/);
});

test('resolveTarget: 相对路径 + projectRoot 解析为绝对', () => {
  const r = resolveTarget('web/src/foo.tsx', '/proj');
  assert.equal(r.value, '/proj/web/src/foo.tsx');
  assert.equal(r.kind, 'file');
});

test('resolveTarget: 相对路径 + line:col 同样工作', () => {
  const r = resolveTarget('web/src/foo.tsx:12:3', '/proj');
  assert.equal(r.value, '/proj/web/src/foo.tsx');
  assert.equal(r.line, 12);
  assert.equal(r.col, 3);
});

test('resolveTarget: projectRoot 必须是绝对路径', () => {
  assert.throws(() => resolveTarget('foo', './rel'), /绝对路径/);
});

test('resolveTarget: .. 不能逃出 projectRoot', () => {
  assert.throws(() => resolveTarget('../../etc/passwd', '/proj'), /逃出/);
  assert.throws(() => resolveTarget('a/b/../../../etc', '/proj'), /逃出/);
});

test('resolveTarget: 路径内含 .. 但不逃出 → 允许', () => {
  const r = resolveTarget('web/../core/foo.ts', '/proj');
  assert.equal(r.value, '/proj/core/foo.ts');
});

test('buildOpenCommand: URL → open <url>', () => {
  const { cmd, args } = buildOpenCommand({ kind: 'url', value: 'https://x' });
  assert.equal(cmd, 'open');
  assert.deepEqual(args, ['https://x']);
});

test('buildOpenCommand: 无 VS Code → open <path>', () => {
  _resetVSCodeCache();
  // 模拟无 VS Code：临时把 PATH 清空，候选路径已经在 lib 内 hardcode，但 fs.existsSync 仍可能命中
  // —— 这个用例与本机状态有关，我们这里只关心当 detectVSCode 返回 null 时的行为；
  // 直接 mock 不方便，改成在测试机上若没有 VS Code，则进入这条分支。
  // 这里只断言 cmd 是 'open' 或 detect 到的 VS Code 路径之一。
  const { cmd, args } = buildOpenCommand({ kind: 'file', value: '/x/y' });
  if (cmd === 'open') {
    assert.deepEqual(args, ['/x/y']);
  } else {
    // VS Code 命中
    assert.match(cmd, /code|codium/);
    assert.deepEqual(args, ['/x/y']);
  }
});

test('buildOpenCommand: 文件 + line → VS Code 时用 -g loc', () => {
  _resetVSCodeCache();
  const { cmd, args } = buildOpenCommand({ kind: 'file', value: '/x/y', line: 42, col: 7 });
  if (cmd === 'open') {
    // 系统 open 不支持 line/col，安全降级为只传路径
    assert.deepEqual(args, ['/x/y']);
  } else {
    assert.deepEqual(args, ['-g', '/x/y:42:7']);
  }
});

test('buildOpenCommand: 文件 + line 无 col → :line', () => {
  _resetVSCodeCache();
  const { cmd, args } = buildOpenCommand({ kind: 'file', value: '/x/y', line: 5 });
  if (cmd !== 'open') {
    assert.deepEqual(args, ['-g', '/x/y:5']);
  }
});
