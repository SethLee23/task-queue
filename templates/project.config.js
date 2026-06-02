// 由 task-queue init 生成，可手工编辑
/* eslint-disable */

const MODULE_DICT = __MODULE_DICT__;

module.exports = {
  scopes: __SCOPES__,

  buildCommands: __BUILD_COMMANDS__,

  versionFiles: __VERSION_FILES__,

  changelogFiles: __CHANGELOG_FILES__,

  sameDayShareVersion: __SAME_DAY_SHARE__,

  /**
   * 根据变更文件列表推断所属模块名（中文）。
   * @param {string[]} changedFiles git diff --name-only 的结果数组
   * @param {string} scope 当前提交 scope（如 "web" / "core"）
   * @returns {string|null} 中文模块名，未命中返回 null
   */
  inferModule: (changedFiles, scope) => {
    // 第一个匹配到目录关键字的优先返回
    const dict = MODULE_DICT[scope] || {};
    for (const file of changedFiles) {
      for (const [key, name] of Object.entries(dict)) {
        if (file.includes('/' + key + '/') || file.includes('/' + key.toLowerCase() + '/')) {
          return name;
        }
      }
    }
    // 都没命中 → 默认值
    const defaults = __DEFAULT_MODULE__;
    return defaults[scope] || null;
  },

  /**
   * 根据 scope、模块、描述和版本号生成 commit message。
   * @param {{ id: number|string, scope: string, module: string, desc: string, summary: string, version: string }} params
   * @returns {string}
   */
  commitMessage: ({ id, scope, module, desc, summary, version }) => {
    const templates = __COMMIT_TEMPLATES__;
    const tpl = templates[scope];
    return tpl
      .replace('{id}', id ?? '')
      .replace('{version}', version)
      .replace('{module}', module)
      .replace('{desc}', desc)
      .replace('{summary}', summary ?? '');
  },

  autoPush: false,

  /**
   * loop 空转/等待时的睡眠间隔（秒）。
   * - 默认 270s = 4.5 分钟，刚好在 Anthropic prompt cache 5min TTL 内
   * - 范围 [60, 3600]，调大省 token / 调小响应更快
   * - 影响 loop-prompt Step 5 的 idle 和 review/blocked 两种等待
   */
  idleSleepSeconds: 270,
};
