const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FIELDS = [
  'scopes',
  'buildCommands',
  'versionFiles',
  'changelogFiles',
  'inferModule',
  'commitMessage',
];

/**
 * 加载并校验项目侧配置文件 <projectRoot>/.tasks/project.config.js
 * @param {string} projectRoot 项目根目录绝对路径
 * @returns {object} 已校验的配置对象
 */
function loadProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.tasks', 'project.config.js');
  if (!fs.existsSync(configPath)) {
    throw new Error(`project.config.js 不存在：${configPath}`);
  }
  // 清缓存以支持单元测试多次覆盖不同配置
  delete require.cache[require.resolve(configPath)];
  const cfg = require(configPath);
  for (const field of REQUIRED_FIELDS) {
    if (cfg[field] == null) {
      throw new Error(`project.config.js 缺少字段 ${field}`);
    }
  }
  // 并行执行配置:缺失字段按关闭兜底,存量项目行为与串行版完全一致
  cfg.parallel = {
    enabled: false,
    maxConcurrency: 3,
    allowSameScope: false,
    ...(cfg.parallel || {}),
  };
  return cfg;
}

module.exports = { loadProjectConfig, getIdleSleepSeconds, getMaxRounds };

/**
 * 读取 idleSleepSeconds 配置项，缺省/异常/越界都安全兜底。
 * - 默认 270s（在 Anthropic prompt cache 5 分钟 TTL 内）
 * - 范围 [60, 3600]，与 ScheduleWakeup 内部 clamp 一致
 * @param {object} cfg loadProjectConfig 的返回对象
 * @returns {number}
 */
function getIdleSleepSeconds(cfg) {
  const v = cfg && cfg.idleSleepSeconds;
  if (v == null) return 270;
  const n = Number(v);
  if (!Number.isFinite(n)) return 270;
  return Math.max(60, Math.min(3600, Math.round(n)));
}

/**
 * 读取 maxRounds 配置项（watchdog 主动上下文重置阈值），缺省/异常/越界都安全兜底。
 * - 默认 40（≈ 上下文封顶 ~210k，约 3h/次冷启动，见 loop-context-proactive-reset 方案 §5）
 * - 范围 [5, 500]：下限 5 便于真机观察，上限 500 防误配成天文数字使重置形同失效
 * @param {object} cfg loadProjectConfig 的返回对象
 * @returns {number}
 */
function getMaxRounds(cfg) {
  const v = cfg && cfg.maxRounds;
  if (v == null) return 40;
  const n = Number(v);
  if (!Number.isFinite(n)) return 40;
  return Math.max(5, Math.min(500, Math.round(n)));
}
