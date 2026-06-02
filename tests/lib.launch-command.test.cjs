'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lc = require('../lib/launch-command.cjs');

test('sessionName 规约为 task-queue-loop-<slug>', () => {
  assert.equal(lc.sessionName('aggregates'), 'task-queue-loop-aggregates');
});

test('shellSingleQuote 转义单引号', () => {
  assert.equal(lc.shellSingleQuote("a'b"), "'a'\\''b'");
});

test('buildLoopPrompt 替换 ${PROJECT_ROOT} 且去尾部空白', () => {
  const prompt = lc.buildLoopPrompt('/tmp/some-proj');
  assert.ok(!prompt.includes('${PROJECT_ROOT}'), 'PROJECT_ROOT 应被替换');
  assert.ok(prompt.includes('/tmp/some-proj'), '应含真实根路径');
  assert.equal(prompt, prompt.replace(/\s+$/, ''), '应无尾部空白');
});

test('renderStartScript 产出含 attach 的人用三段脚本', () => {
  const s = lc.renderStartScript('/tmp/some-proj', 'demo');
  assert.ok(s.startsWith("SESSION='task-queue-loop-demo'"));
  assert.ok(s.includes('tmux new-session -ds "$SESSION"'));
  assert.ok(s.includes('tmux send-keys -t "$SESSION"'));
  assert.ok(s.includes('tmux attach -t "$SESSION"'));
  assert.ok(s.includes("-c '/tmp/some-proj'"));
});

test('launchHeadless 调 new-session + send-keys 且绝不 attach', () => {
  const calls = [];
  const mockExec = (bin, args) => { calls.push([bin, ...args]); };
  const session = lc.launchHeadless('/tmp/some-proj', 'demo', mockExec);
  assert.equal(session, 'task-queue-loop-demo');
  const flat = calls.map(c => c.join(' '));
  assert.ok(flat.some(c => c.startsWith('tmux new-session -ds task-queue-loop-demo')), 'should new-session detached');
  assert.ok(flat.some(c => c.startsWith('tmux send-keys -t task-queue-loop-demo')), 'should send-keys');
  assert.ok(!flat.some(c => c.includes('attach')), '无头绝不能 attach');
  assert.ok(flat.some(c => c.includes('/loop') && c.includes('claude --dangerously-skip-permissions')), '应注入 claude /loop');

  const promptFile = path.join(os.tmpdir(), 'tq-loop-demo.prompt');
  assert.ok(fs.existsSync(promptFile), 'launchHeadless 应写出 prompt 文件');
  const written = fs.readFileSync(promptFile, 'utf8');
  assert.ok(!written.includes('${PROJECT_ROOT}'), 'prompt 文件不应残留 ${PROJECT_ROOT}');
  assert.ok(written.includes('/tmp/some-proj'), 'prompt 文件应含已替换的根路径');
  fs.rmSync(promptFile, { force: true });
});
