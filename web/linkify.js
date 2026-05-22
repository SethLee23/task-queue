// web/linkify.js — Claude 写到任务字段 (desc/note/risk/question) 里的路径/URL 自动识别。
// 同时支持浏览器 (附到 window.Linkify) 与 Node.js (module.exports)，方便单元测试。

(function () {
  'use strict';

  // 组合正则。前置 lookbehind 防止从词中间切入（避免 mywebsrc/foo 误匹配 src/foo）。
  // 四个 alternation 分组分别是：URL / 以 / 或 ~/ 开头 / 多段相对路径 / 单段 file:line
  const RE = new RegExp(
    '(?<![\\w/.@\\-])' +
    '(?:' +
      '(https?:\\/\\/[^\\s<>"\'`「『\\u3010\\uFF08]+)' +
      '|((?:~\\/|\\/)[\\w@.\\-]+(?:\\/[\\w@.\\-]+)*(?::\\d+(?::\\d+)?)?)' +
      '|([\\w@\\-][\\w@.\\-]*(?:\\/[\\w@.\\-]+)+(?::\\d+(?::\\d+)?)?)' +
      '|([\\w@\\-][\\w@\\-]*\\.[\\w]+:\\d+(?::\\d+)?)' +
    ')',
    'g',
  );

  // URL 末尾常见标点修剪（不应作为 URL 一部分）
  const URL_TRAIL_RE = /[.,;:!?)\]」』！？。，；：'"`>]+$/;
  // 括号成对修剪：若 URL 以 ) 结尾但匹配到的 ) 数 > ( 数，剥掉多余的 )
  function trimBalancedParens(s) {
    let opens = 0, lastBalance = s.length;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') opens++;
      else if (s[i] === ')') {
        if (opens === 0) return s.slice(0, i);
        opens--;
      }
    }
    return s;
  }

  /**
   * 在 text 里找所有 URL / 路径匹配。
   * @param {string} text
   * @returns {{ start: number, end: number, text: string, kind: 'url' | 'file' }[]}
   */
  function findLinks(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(text)) !== null) {
      let raw = m[0];
      const kind = m[1] ? 'url' : 'file';
      if (kind === 'url') {
        raw = trimBalancedParens(raw);
        raw = raw.replace(URL_TRAIL_RE, '');
      } else {
        // 文件类匹配的尾部不需要修剪，因为字符类已经把标点排除在外了
      }
      if (!raw) continue;
      out.push({
        start: m.index,
        end: m.index + raw.length,
        text: raw,
        kind,
      });
      // 推进 lastIndex 到这次匹配末尾，避免无限循环或重复
      RE.lastIndex = m.index + raw.length;
    }
    return out;
  }

  /**
   * 把 text 切成 [string|anchor] 数组；anchor 构造交给调用方（隔离 DOM 依赖）。
   * @param {string} text
   * @param {(match: { text: string, kind: string }) => any} makeAnchor
   * @returns {Array<string|any>}
   */
  function linkify(text, makeAnchor) {
    const links = findLinks(text);
    if (links.length === 0) return [text || ''];
    const parts = [];
    let cursor = 0;
    for (const link of links) {
      if (link.start > cursor) parts.push(text.slice(cursor, link.start));
      parts.push(makeAnchor(link));
      cursor = link.end;
    }
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  }

  const api = { findLinks, linkify, RE };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.Linkify = api;
  }
})();
