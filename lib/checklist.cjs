// lib/checklist.cjs — 子任务清单纯函数工具库
//
// 数据形态:
//   存储:   JSON 字符串(写入 Excel 的 checklist 列),例如 '[{"text":"a","done":true},{"text":"b","done":false}]'
//   内存:   { text: string, done: boolean }[]
//
// 设计约束:
// - 老 Excel 行无 checklist 字段或字段为空字符串 → 一律返回 [],不抛
// - 所有 mutation 都返回新数组(不修改原数组),便于上游 diff / 比较
// - CLI 用户索引一律 1-based(与任务 id 习惯一致),内部计算用 0-based
//
'use strict';

/**
 * 把存储字段(JSON 字符串 / 已是数组 / null / undefined)统一规整为 checklist 数组。
 * 解析失败 → []。每一项缺字段自动补默认(text='', done=false)。
 *
 * @param {unknown} raw
 * @returns {{ text: string, done: boolean }[]}
 */
function parseChecklist(raw) {
  if (raw == null || raw === '') return [];
  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    try {
      arr = JSON.parse(String(raw));
    } catch (_) {
      return [];
    }
    if (!Array.isArray(arr)) return [];
  }
  return arr
    .map(it => {
      if (typeof it === 'string') return { text: it, done: false };
      if (it && typeof it === 'object') {
        return {
          text: String(it.text ?? '').trim(),
          done: Boolean(it.done),
        };
      }
      return null;
    })
    .filter(it => it && it.text);
}

/**
 * 序列化 checklist 数组为 Excel 存储字符串。空数组 → ''(不占字段)。
 *
 * @param {{ text: string, done?: boolean }[]} items
 * @returns {string}
 */
function serializeChecklist(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return JSON.stringify(
    items
      .map(it => ({ text: String(it.text ?? '').trim(), done: Boolean(it.done) }))
      .filter(it => it.text),
  );
}

/**
 * 把管道分隔(或换行/逗号分隔)的字符串拆为初始未勾选的 checklist。
 * 用于 set-checklist CLI 调用。
 *
 * @param {string} pipeStr
 * @returns {{ text: string, done: boolean }[]}
 */
function fromPipeString(pipeStr) {
  if (!pipeStr) return [];
  return String(pipeStr)
    .split(/[|\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(text => ({ text, done: false }));
}

/**
 * 全量替换 checklist。
 * @param {{ text: string, done: boolean }[]} _items 旧数组(占位,与 mutator 签名对齐)
 * @param {{ text: string, done?: boolean }[]} next 新数组
 */
function setItems(_items, next) {
  return parseChecklist(next);
}

/**
 * 追加一条未勾子项。
 * @param {{ text: string, done: boolean }[]} items
 * @param {string} text
 */
function addItem(items, text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('add-checklist 需要 <text>');
  return [...items, { text: t, done: false }];
}

/**
 * 按 1-based 索引删除一条。
 * @param {{ text: string, done: boolean }[]} items
 * @param {number|string} indexOneBased
 */
function delItem(items, indexOneBased) {
  const idx = parseInt(indexOneBased, 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
    throw new Error(`索引越界: ${indexOneBased}(当前有 ${items.length} 项)`);
  }
  return items.filter((_, i) => i !== idx);
}

/**
 * 按 1-based 索引把 done 设为目标值。
 * @param {{ text: string, done: boolean }[]} items
 * @param {number|string} indexOneBased
 * @param {boolean} done
 */
function setDone(items, indexOneBased, done) {
  const idx = parseInt(indexOneBased, 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
    throw new Error(`索引越界: ${indexOneBased}(当前有 ${items.length} 项)`);
  }
  return items.map((it, i) => (i === idx ? { ...it, done } : it));
}

/**
 * 按 1-based 索引改文本(不改 done)。
 * @param {{ text: string, done: boolean }[]} items
 * @param {number|string} indexOneBased
 * @param {string} newText
 */
function editText(items, indexOneBased, newText) {
  const idx = parseInt(indexOneBased, 10) - 1;
  const t = String(newText || '').trim();
  if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
    throw new Error(`索引越界: ${indexOneBased}(当前有 ${items.length} 项)`);
  }
  if (!t) throw new Error('edit-checklist 需要 <text>');
  return items.map((it, i) => (i === idx ? { ...it, text: t } : it));
}

/**
 * 计算 {done, total, ratio, nextUndone}。
 * @param {{ text: string, done: boolean }[]} items
 */
function summarize(items) {
  const total = items.length;
  const done = items.filter(it => it.done).length;
  const nextUndone = items.find(it => !it.done) || null;
  return {
    done,
    total,
    ratio: total === 0 ? 0 : done / total,
    nextUndone: nextUndone ? nextUndone.text : null,
  };
}

module.exports = {
  parseChecklist,
  serializeChecklist,
  fromPipeString,
  setItems,
  addItem,
  delItem,
  setDone,
  editText,
  summarize,
};
