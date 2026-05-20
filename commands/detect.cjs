// commands/detect.cjs — 静态分析项目结构，输出 JSON 配置建议
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MODULE_DICT } = require('../lib/module-dict.cjs');

/**
 * 宽容读文件，任何错误返回 null。
 * @param {string} filePath 绝对路径
 * @returns {string|null}
 */
function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * 宽容读 JSON 文件，任何错误返回 null。
 * @param {string} filePath 绝对路径
 * @returns {object|null}
 */
function safeReadJson(filePath) {
  const text = safeRead(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * 宽容执行 git 命令，失败返回 null。
 * @param {string} cwd 工作目录
 * @param {string[]} args git 参数列表
 * @returns {string|null}
 */
function gitRun(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return null;
  }
}

/**
 * 分析单个包目录（读取 version / buildCommand / changelogFile / candidateModules）。
 * @param {string} projectRoot 项目根目录绝对路径
 * @param {string} subdir 相对于 projectRoot 的子目录路径（根包传 '.'）
 * @returns {{ dir: string, name: string, version: string|null, versionFile: string, buildCommand: string|null, changelogFile: string|null, candidateModules: string[] }|null}
 */
function detectPackage(projectRoot, subdir) {
  const dirAbs = path.join(projectRoot, subdir);
  const pkgPath = path.join(dirAbs, 'package.json');
  const pkg = safeReadJson(pkgPath);
  if (!pkg) return null;

  // 探测 build 脚本
  const scripts = pkg.scripts || {};
  let buildScript = null;
  for (const key of ['build', 'compile', 'tsc']) {
    if (scripts[key]) { buildScript = key; break; }
  }
  const buildCommand = buildScript
    ? (subdir === '.' ? `npm run ${buildScript}` : `cd ${subdir} && npm run ${buildScript}`)
    : null;

  // 探测 changelog 文件（含版本标题 `## x.y.z`）
  let changelogFile = null;
  const candidates = subdir === '.'
    ? ['CHANGELOG.md', 'README.md']
    : [path.join(subdir, 'README.md'), path.join(subdir, 'CHANGELOG.md'), 'CHANGELOG.md'];

  for (const candidate of candidates) {
    const content = safeRead(path.join(projectRoot, candidate));
    if (content && /^## \d+\.\d+/m.test(content)) {
      changelogFile = candidate;
      break;
    }
  }

  // 探测候选模块（扫第一个存在的 probe 目录的一级子目录）
  const candidateModules = [];
  const seen = new Set();
  for (const probe of ['src/view', 'src/modules', 'modules', 'src']) {
    const probePath = path.join(dirAbs, probe);
    let stat;
    try { stat = fs.statSync(probePath); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    for (const sub of fs.readdirSync(probePath)) {
      if (sub.startsWith('.') || sub.startsWith('_')) continue;
      let subStat;
      try { subStat = fs.statSync(path.join(probePath, sub)); } catch (_) { continue; }
      if (!subStat.isDirectory()) continue;
      const cn = MODULE_DICT[sub] || sub;
      if (!seen.has(cn)) { seen.add(cn); candidateModules.push(cn); }
    }
    break; // 第一个命中即止
  }

  return {
    dir: subdir,
    name: pkg.name || subdir,
    version: pkg.version || null,
    versionFile: path.join(subdir, 'package.json'),
    buildCommand,
    changelogFile,
    candidateModules,
  };
}

/**
 * 探测 commit 模板：读取最近 50 条 git log，匹配 T#xxxx [scope]## ver 格式。
 * @param {string} projectRoot
 * @returns {{ detected: string|null, samples: string[] }|null}
 */
function detectCommitPattern(projectRoot) {
  const out = gitRun(projectRoot, ['log', '-50', '--pretty=%s%n%b%n###---###']);
  if (!out) return null;
  const samples = out
    .split('###---###')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5);
  const hasPattern = samples.some(s => /T#\d+\s+\S*##\s*\S+/.test(s));
  return {
    detected: hasPattern ? 'T#0000 {scope}## {version}\n\n【模块】描述；' : null,
    samples,
  };
}

/**
 * 启发式判断同日是否共用版本号。
 * 只统计当天有 ≥2 次带版本号 commit 的日期，版本号全相同 → sameDay++，有差异 → diffDay++。
 * @param {string} projectRoot
 * @returns {'likely_true'|'likely_false'|'unknown'}
 */
function detectSameDayShare(projectRoot) {
  const out = gitRun(projectRoot, ['log', '-100', '--pretty=%ai|%s']);
  if (!out) return 'unknown';

  /** @type {Map<string, { versions: Set<string>, commits: number }>} */
  const dayInfo = new Map();

  for (const line of out.split('\n').filter(Boolean)) {
    const pipeIdx = line.indexOf('|');
    if (pipeIdx === -1) continue;
    const iso = line.slice(0, pipeIdx);
    const subj = line.slice(pipeIdx + 1);
    const day = iso.slice(0, 10);
    const m = subj.match(/##\s*(\S+)/);
    if (!m) continue; // 无版本号的 commit 不参与统计
    if (!dayInfo.has(day)) dayInfo.set(day, { versions: new Set(), commits: 0 });
    const info = dayInfo.get(day);
    info.commits++;
    info.versions.add(m[1]);
  }

  let sameDay = 0;
  let diffDay = 0;
  for (const [, info] of dayInfo) {
    if (info.commits < 2) continue; // 单 commit 日不参与判断
    if (info.versions.size === 1) sameDay++;
    else diffDay++;
  }

  if (sameDay > diffDay) return 'likely_true';
  if (diffDay > sameDay) return 'likely_false';
  return 'unknown';
}

/**
 * detect 命令主函数：静态分析项目结构，输出 JSON 配置建议到 stdout。
 * projectRoot 为空时默认使用 process.cwd()（允许无参数调用）。
 * @param {string|undefined} projectRoot 项目根目录路径
 * @param {string[]} _args 剩余参数（暂未使用）
 * @returns {Promise<void>}
 */
module.exports = async function detect(projectRoot, _args) {
  if (!projectRoot) projectRoot = process.cwd();

  const packages = [];

  // 根包
  const rootPkg = detectPackage(projectRoot, '.');
  if (rootPkg) packages.push(rootPkg);

  // 一级子目录扫描
  let entries;
  try {
    entries = fs.readdirSync(projectRoot);
  } catch (_) {
    entries = [];
  }
  for (const sub of entries) {
    if (sub.startsWith('.') || sub === 'node_modules') continue;
    const subAbs = path.join(projectRoot, sub);
    let stat;
    try { stat = fs.statSync(subAbs); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const pkg = detectPackage(projectRoot, sub);
    if (pkg) packages.push(pkg);
  }

  const result = {
    type: packages.length > 1 ? 'monorepo' : 'single',
    packages,
    commitPattern: detectCommitPattern(projectRoot),
    sameDayShareVersion: detectSameDayShare(projectRoot),
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
};
