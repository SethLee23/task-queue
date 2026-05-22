'use strict';

/**
 * 本地日期/时间工具函数
 *
 * 统一封装"本地 YYYY-MM-DD"与"本地 HH:MM:SS"的拼接逻辑，
 * 避免各模块内联重复实现。
 */

/**
 * 返回本地日期字符串，格式 YYYY-MM-DD。
 * @param {Date} [date] 指定日期，默认为当前时间
 * @returns {string} 形如 "2026-05-20" 的日期字符串
 */
function localDateStr(date = new Date()) {
  const d = date;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 返回本地时间字符串，格式 HH:MM:SS。
 * @returns {string} 形如 "14:05:09" 的时间字符串
 */
function localTimeStr() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mi}:${ss}`;
}

/**
 * 返回本地日期 + 时间字符串，格式 YYYY-MM-DD HH:MM（无秒，便于人读）。
 * 用于 note 顶部 [reply ...] / [done ...] 等可读时间戳。
 * @returns {string} 形如 "2026-05-21 18:30" 的字符串
 */
function localTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = { localDateStr, localTimeStr, localTimestamp };
