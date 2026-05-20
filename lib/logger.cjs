const fs = require('node:fs');
const path = require('node:path');

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

  /** 返回当天日志文件路径 */
  _file() {
    const today = new Date().toISOString().slice(0, 10);
    return path.join(this.dir, `${today}.log`);
  }

  /** 返回 HH:MM:SS 时间戳 */
  _ts() {
    return new Date().toISOString().slice(11, 19);
  }

  /** @param {string} msg */
  info(msg)  { fs.appendFileSync(this._file(), `[${this._ts()}] ${msg}\n`); }

  /** @param {string} msg */
  warn(msg)  { fs.appendFileSync(this._file(), `[${this._ts()}] [warn] ${msg}\n`); }

  /** @param {string} msg */
  error(msg) { fs.appendFileSync(this._file(), `[${this._ts()}] [error] ${msg}\n`); }
}

module.exports = { Logger };
