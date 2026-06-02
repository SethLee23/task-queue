'use strict';
// web/note-blocks.js — 任务 note 文本块解析器（纯函数，无 DOM 依赖）
// 同时支持浏览器（附到 window.NoteBlocks）与 Node.js（module.exports），便于单元测试。
//
// note 块格式约定（reply.cjs / done.cjs 落盘形态）：
//   1) 头独占一行：`[done 时间]` / `[<用户> 回复 LATEST|OBSOLETE 时间]`
//   2) 单行追加：`[<用户> 回复 LATEST 时间] 答复正文`（reply.cjs 非 resume 路径）
//   3) 多块以 `---` 分隔
// dashboard 需把"[tag] 正文"形态也识别成同一个块，否则正文会与 header 一起被当成裸文本渲染。

(function () {
  const NOTE_HEADER_RE = /^\[([^\[\]]+)\](?:\s+(.*))?$/;

  function parseNoteBlocks(note) {
    if (!note) return [];
    const lines = String(note).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let cur = null;
    for (const line of lines) {
      const m = line.match(NOTE_HEADER_RE);
      if (m) {
        if (cur) blocks.push(cur);
        cur = { header: m[1], bodyLines: [] };
        if (m[2] != null && m[2] !== '') cur.bodyLines.push(m[2]);
      } else {
        if (!cur) cur = { header: null, bodyLines: [] };
        cur.bodyLines.push(line);
      }
    }
    if (cur) blocks.push(cur);
    for (const b of blocks) {
      while (b.bodyLines.length && b.bodyLines[b.bodyLines.length - 1].trim() === '') b.bodyLines.pop();
      while (b.bodyLines.length && b.bodyLines[0].trim() === '') b.bodyLines.shift();
    }
    return blocks.filter(b => b.header || b.bodyLines.length);
  }

  function classifyNoteBlock(block) {
    if (!block.header) return { kind: 'other', header: null };
    const h = block.header.trim();
    let m;
    m = h.match(/^done\s+(.+)$/i);
    if (m) return { kind: 'done', when: m[1].trim() };
    m = h.match(/^(.+?)\s+回复\s+(LATEST|OBSOLETE)\s+(.+)$/i);
    if (m) return { kind: 'reply', user: m[1].trim(), latest: m[2].toUpperCase() === 'LATEST', when: m[3].trim() };
    m = h.match(/^reply\s+(LATEST|OBSOLETE)\s+(.+)$/i);
    if (m) return { kind: 'reply', user: null, latest: m[1].toUpperCase() === 'LATEST', when: m[2].trim() };
    return { kind: 'other', header: h };
  }

  function splitReplyBody(bodyLines) {
    let answerIdx = -1;
    for (let i = 0; i < bodyLines.length; i++) {
      if (/^A:\s*/i.test(bodyLines[i])) { answerIdx = i; break; }
    }
    if (answerIdx < 0) return { contextLines: [], answerLines: bodyLines.slice() };
    return {
      contextLines: bodyLines.slice(0, answerIdx),
      answerLines: [bodyLines[answerIdx].replace(/^A:\s*/i, ''), ...bodyLines.slice(answerIdx + 1)],
    };
  }

  function splitContextLine(line) {
    const m = line.match(/^(Q|Risk):\s*(.*)$/i);
    if (!m) return { label: null, text: line };
    return { label: m[1].toLowerCase() === 'risk' ? '⚠ Risk' : '? 疑问', text: m[2] };
  }

  const api = {
    NOTE_HEADER_RE,
    parseNoteBlocks,
    classifyNoteBlock,
    splitReplyBody,
    splitContextLine,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NoteBlocks = api;
  }
})();
