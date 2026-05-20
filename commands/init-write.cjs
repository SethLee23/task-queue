// commands/init-write.cjs — 将 Claude 收集到的 answers 落盘到项目的 .tasks/ 目录
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createBlankWorkbook } = require('../lib/workbook.cjs');
const { MODULE_DICT } = require('../lib/module-dict.cjs');

/**
 * 一次性替换模板中所有 __X__ 占位符，避免顺序敏感问题。
 * 未在 vars 中定义的占位符保留原字面。
 *
 * @param {string} tpl 模板字符串
 * @param {Record<string, unknown>} vars 占位符键（含双下划线，如 "__SCOPES__"）→ 值的映射
 * @returns {string} 渲染后的字符串
 */
function render(tpl, vars) {
  return tpl.replace(/__[A-Z_]+__/g, (match) => {
    if (Object.prototype.hasOwnProperty.call(vars, match)) {
      const v = vars[match];
      // boolean/number 直接字面量，其余 JSON 序列化
      if (typeof v === 'boolean' || typeof v === 'number') return String(v);
      return JSON.stringify(v, null, 2);
    }
    return match; // 未定义占位符保留原字面
  });
}

/**
 * 从用户确认的 candidateModules（中文列表）反向构建 keyword → 中文名 moduleDict。
 * 使用共享 MODULE_DICT 进行反向映射，确保与 detect 命令完全一致。
 *
 * 注意：MODULE_DICT 中存在多个英文 key 映射同一中文（如 Settings/Global → 全局设置），
 * 反向后最后一个 key 优先（Global）。用户界面层不感知此细节，不影响正确性。
 *
 * @param {Record<string, string[]>} candidateModules scope → 中文模块名列表
 * @returns {Record<string, Record<string, string>>} scope → { 英文目录关键字: 中文模块名 }
 */
function buildModuleDict(candidateModules) {
  // 构造 中文→英文 反向映射，含 MODULE_DICT 的所有条目
  /** @type {Record<string, string>} */
  const reverseDict = Object.fromEntries(
    Object.entries(MODULE_DICT).map(([en, cn]) => [cn, en])
  );

  /** @type {Record<string, Record<string, string>>} */
  const result = {};
  for (const [scope, modules] of Object.entries(candidateModules)) {
    result[scope] = {};
    for (const mod of modules) {
      const key = reverseDict[mod] || mod;
      result[scope][key] = mod;
    }
  }
  return result;
}

/**
 * 构建每个 scope 的默认模块名。
 * 默认取候选列表第一项，若列表为空则返回 "全局"。
 *
 * @param {Record<string, string[]>} candidateModules scope → 中文模块名列表
 * @returns {Record<string, string>} scope → 默认中文模块名
 */
function buildDefaultModule(candidateModules) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const [scope, modules] of Object.entries(candidateModules)) {
    result[scope] = modules.length > 0 ? modules[0] : '全局';
  }
  return result;
}

/**
 * init-write 命令主函数：将 Claude 收集到的配置 answers 渲染并落盘到 <root>/.tasks/。
 *
 * 落盘动作：
 * 1. 创建 .tasks/ 和 .tasks/logs/ 目录
 * 2. 渲染 project.config.js 模板并写入
 * 3. 创建空白 tasks.xlsx（若不存在）
 * 4. 追加 .gitignore 条目（幂等，不重复追加）
 *
 * 输出 JSON 到 stdout：{ created, gitignoreAppended }
 *
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string[]} args 剩余参数，args[0] 为 answers JSON 字符串
 * @returns {Promise<void>}
 */
module.exports = async function initWrite(projectRoot, args) {
  const answersJsonRaw = args[0];
  if (!answersJsonRaw) throw new Error('init-write 需要 <answers-json> 参数');

  /** @type {{ autoCommitScopes: string[], scopeMapping: Record<string, { dir: string, versionFile: string, changelogFile: string, buildCommand: string }>, candidateModules: Record<string, string[]>, commitTemplate: Record<string, string>, sameDayShareVersion: boolean }} */
  let answers;
  try {
    answers = JSON.parse(answersJsonRaw);
  } catch (e) {
    throw new Error(`answers-json 解析失败: ${e.message}`);
  }

  const tasksDir = path.join(projectRoot, '.tasks');
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(path.join(tasksDir, 'logs'), { recursive: true });

  // 构造 scopes / buildCommands / versionFiles / changelogFiles
  /** @type {Record<string, { dir: string, autoCommit: boolean }>} */
  const scopes = {};
  /** @type {Record<string, string>} */
  const buildCommands = {};
  /** @type {Record<string, string>} */
  const versionFiles = {};
  /** @type {Record<string, string>} */
  const changelogFiles = {};

  for (const [name, info] of Object.entries(answers.scopeMapping || {})) {
    scopes[name] = { dir: info.dir, autoCommit: (answers.autoCommitScopes || []).includes(name) };
    buildCommands[name] = info.buildCommand;
    versionFiles[name] = info.versionFile;
    changelogFiles[name] = info.changelogFile;
  }

  const moduleDict = buildModuleDict(answers.candidateModules || {});
  const defaultModule = buildDefaultModule(answers.candidateModules || {});

  // 渲染模板
  const tplPath = path.join(__dirname, '..', 'templates', 'project.config.js');
  const tpl = fs.readFileSync(tplPath, 'utf8');
  const rendered = render(tpl, {
    __SCOPES__:            scopes,
    __BUILD_COMMANDS__:    buildCommands,
    __VERSION_FILES__:     versionFiles,
    __CHANGELOG_FILES__:   changelogFiles,
    __SAME_DAY_SHARE__:    !!answers.sameDayShareVersion,
    __MODULE_DICT__:       moduleDict,
    __DEFAULT_MODULE__:    defaultModule,
    __COMMIT_TEMPLATES__:  answers.commitTemplate || {},
  });

  fs.writeFileSync(path.join(tasksDir, 'project.config.js'), rendered);

  // 创建空白 xlsx（幂等）
  const xlsxPath = path.join(tasksDir, 'tasks.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    await createBlankWorkbook(xlsxPath);
  }

  // 追加 .gitignore 条目（幂等）
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const gitignoreEntries = [
    '.tasks/tasks.xlsx',
    '.tasks/tasks.xlsx.bak',
    '.tasks/logs/',
    '.tasks/*.bak',
  ];
  let gitignoreContent = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';
  const existingLines = new Set(gitignoreContent.split('\n').map(l => l.trim()));
  let appended = false;
  for (const entry of gitignoreEntries) {
    if (!existingLines.has(entry)) {
      if (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n')) {
        gitignoreContent += '\n';
      }
      gitignoreContent += entry + '\n';
      existingLines.add(entry);
      appended = true;
    }
  }
  if (appended) fs.writeFileSync(gitignorePath, gitignoreContent);

  process.stdout.write(JSON.stringify({
    created: {
      configFile: path.join('.tasks', 'project.config.js'),
      xlsxFile:   path.join('.tasks', 'tasks.xlsx'),
      logsDir:    path.join('.tasks', 'logs'),
    },
    gitignoreAppended: appended,
  }, null, 2) + '\n');
};
