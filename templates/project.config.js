// 由 task-queue init 生成，可手工编辑
/* eslint-disable */

const MODULE_DICT = __MODULE_DICT__;

module.exports = {
  scopes: __SCOPES__,

  buildCommands: __BUILD_COMMANDS__,

  versionFiles: __VERSION_FILES__,

  changelogFiles: __CHANGELOG_FILES__,

  sameDayShareVersion: __SAME_DAY_SHARE__,

  // 并行执行(v2):code 任务进独立 worktree 并发跑,non-code(调研/问答)不开 worktree。
  // allowSameScope=true 时同 scope 任务由主 Claude 判断 desc 文件不重叠后放行,撞了有 rebase→review 兜底。
  // 存量项目没有本字段 = 关闭(纯串行,行为不变)。
  parallel: {
    enabled: true,
    maxConcurrency: 3,
    allowSameScope: true,
  },

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

  /**
   * watchdog 主动上下文重置阈值：本会话唤醒轮数 ≥ 此值且 loop 健康空闲时，
   * 在上下文胀到拖垮成本前主动重启 loop（把上下文从 ~50k 地板重来）。
   * - 默认 40 ≈ 上下文封顶 ~210k、约 3h/次冷启动
   * - 范围 [5, 500]，繁忙项目可调低（如 25）更勤重置，几乎不挂机的可调高（如 80）
   * - executing 不打断、paused 不碰；复用 watchdog 既有安全闸
   */
  maxRounds: 40,
};
