'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseNoteBlocks, classifyNoteBlock } = require('../web/note-blocks.js');

// 单行 reply 格式（reply.cjs 非 resume / risk 空时落盘的形态）：
//   [李思情 回复 LATEST 2026-05-28 14:20] 没有给我返回回复啊
// dashboard 必须能识别为 LATEST reply 块，而不是 fall through 到 'other'。
test('parseNoteBlocks: 单行 [tag] text 形式被识别为 reply 块', () => {
  const note = '[李思情 回复 LATEST 2026-05-28 14:20] 没有给我返回回复啊';
  const blocks = parseNoteBlocks(note);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].header, '李思情 回复 LATEST 2026-05-28 14:20');
  assert.deepEqual(blocks[0].bodyLines, ['没有给我返回回复啊']);
  const meta = classifyNoteBlock(blocks[0]);
  assert.equal(meta.kind, 'reply');
  assert.equal(meta.latest, true);
  assert.equal(meta.user, '李思情');
  assert.equal(meta.when, '2026-05-28 14:20');
});

test('parseNoteBlocks: 单行 [tag] text 后跟附加正文行', () => {
  const note = [
    '[李思情 回复 LATEST 2026-05-28 14:20] 没有给我返回回复啊',
    '.tasks/attachments/2026-05-28T06-20-05-942Z-y53e.png',
  ].join('\n');
  const blocks = parseNoteBlocks(note);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].header, '李思情 回复 LATEST 2026-05-28 14:20');
  assert.deepEqual(blocks[0].bodyLines, [
    '没有给我返回回复啊',
    '.tasks/attachments/2026-05-28T06-20-05-942Z-y53e.png',
  ]);
  assert.equal(classifyNoteBlock(blocks[0]).kind, 'reply');
});

test('parseNoteBlocks: 单行 LATEST + --- + 多行 OBSOLETE 历史块共存', () => {
  const note = [
    '[李思情 回复 LATEST 2026-05-28 14:20] 没有给我返回回复啊',
    '---',
    '[李思情 回复 OBSOLETE 2026-05-28 14:11]',
    'Risk: scope ditto 不允许自动 commit',
    'A: 这个可以了',
  ].join('\n');
  const blocks = parseNoteBlocks(note);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].header, '李思情 回复 LATEST 2026-05-28 14:20');
  assert.equal(classifyNoteBlock(blocks[0]).kind, 'reply');
  assert.equal(classifyNoteBlock(blocks[0]).latest, true);
  assert.equal(blocks[1].header, '李思情 回复 OBSOLETE 2026-05-28 14:11');
  assert.equal(classifyNoteBlock(blocks[1]).kind, 'reply');
  assert.equal(classifyNoteBlock(blocks[1]).latest, false);
});

test('parseNoteBlocks: 既有的多行 [tag]\\nbody 形式仍然工作', () => {
  const note = [
    '[李思情 回复 LATEST 2026-05-28 14:11]',
    'Risk: scope ditto 不允许自动 commit',
    'A: 这个可以了',
  ].join('\n');
  const blocks = parseNoteBlocks(note);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].header, '李思情 回复 LATEST 2026-05-28 14:11');
  assert.deepEqual(blocks[0].bodyLines, [
    'Risk: scope ditto 不允许自动 commit',
    'A: 这个可以了',
  ]);
});

test('parseNoteBlocks: done 块（独占行）继续可识别', () => {
  const note = [
    '[done 2026-05-28 14:00]',
    'commit abc1234 · 【web】 1.2.3',
    '改 ReqConfig label 中文',
  ].join('\n');
  const blocks = parseNoteBlocks(note);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].header, 'done 2026-05-28 14:00');
  assert.equal(classifyNoteBlock(blocks[0]).kind, 'done');
});
