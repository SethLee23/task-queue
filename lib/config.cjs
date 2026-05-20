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
  return cfg;
}

module.exports = { loadProjectConfig };
