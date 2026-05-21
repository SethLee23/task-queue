'use strict';

const { clearWakeNow } = require('../lib/wake.cjs');

/**
 * 清除项目的 wake-now 旗子（幂等，旗子不存在也不报错）。
 * loop-prompt Step 0.5 在检查到 wakeNow:true 后调用，避免下轮误判。
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @returns {Promise<void>}
 */
module.exports = async function clearWake(projectRoot) {
  clearWakeNow(projectRoot);
  process.stdout.write('ok\n');
};
