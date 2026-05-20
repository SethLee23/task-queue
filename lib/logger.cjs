const fs = require('node:fs');
const path = require('node:path');
const { localDateStr, localTimeStr } = require('./datetime.cjs');

/**
 * 按天滚动写入日志到 <projectRoot>/.tasks/logs/YYYY-MM-DD.log
 */
class Logger {
  /**
   * @param {string} projectRoot 项目根目录绝对路径
   */
  constructor(projectRoot) {
    this.dir = path.join(projectRoot, '.tasks', 'logs');
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /** 返回当天日志文件路径（本地日期 YYYY-MM-DD） */
  _file() {
    return path.join(this.dir, `${localDateStr()}.log`);
  }

  /** 返回本地时间 HH:MM:SS 时间戳 */
  _ts() {
    return localTimeStr();
  }

  /** @param {string} msg */
  info(msg)  { fs.appendFileSync(this._file(), `[${this._ts()}] ${msg}\n`); }

  /** @param {string} msg */
  warn(msg)  { fs.appendFileSync(this._file(), `[${this._ts()}] [warn] ${msg}\n`); }

  /** @param {string} msg */
  error(msg) { fs.appendFileSync(this._file(), `[${this._ts()}] [error] ${msg}\n`); }
}

module.exports = { Logger };
