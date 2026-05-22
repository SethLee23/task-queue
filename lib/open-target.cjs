'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * 把 dashboard linkify 出来的 target 字符串解析成可执行的打开动作。
 *
 * 输入示例：
 *   - "https://example.com"
 *   - "/Users/seth/foo.txt"
 *   - "web/src/foo.tsx"               （需要 projectRoot 解析）
 *   - "web/src/foo.tsx:42"            （带行号）
 *   - "web/src/foo.tsx:42:7"          （带行号 + 列号）
 *   - "~/.claude/foo"                  （展开 HOME）
 *
 * @param {string} target
 * @param {string} [projectRoot] 用于解析相对路径；缺省时相对路径会被拒绝
 * @returns {{ kind: 'url', value: string }
 *         | { kind: 'file', value: string, line?: number, col?: number }}
 * @throws Error 校验失败时
 */
function resolveTarget(target, projectRoot) {
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error('target 必填');
  }
  const raw = target.trim();
  if (raw.startsWith('-')) throw new Error('target 不能以 - 开头');

  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'url', value: raw };
  }

  // 解析尾部 :line:col 后缀（仅当 line 是纯数字时才剥）
  let pathPart = raw;
  let line, col;
  const m = raw.match(/^(.+?)(?::(\d+)(?::(\d+))?)?$/);
  if (m) {
    pathPart = m[1];
    if (m[2] != null) line = parseInt(m[2], 10);
    if (m[3] != null) col = parseInt(m[3], 10);
  }

  // 展开 ~ 前缀
  if (pathPart === '~') pathPart = os.homedir();
  else if (pathPart.startsWith('~/')) pathPart = path.join(os.homedir(), pathPart.slice(2));

  let absPath;
  if (path.isAbsolute(pathPart)) {
    absPath = path.normalize(pathPart);
  } else {
    if (!projectRoot) throw new Error('相对路径需要 projectRoot');
    if (!path.isAbsolute(projectRoot)) throw new Error('projectRoot 必须是绝对路径');
    absPath = path.resolve(projectRoot, pathPart);
    // 防止 ..  逃逸
    const rel = path.relative(projectRoot, absPath);
    if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
      throw new Error('路径不能逃出 projectRoot');
    }
  }

  return { kind: 'file', value: absPath, line, col };
}

/** VS Code 可执行路径，按概率排序；模块级缓存避免每次扫盘 */
const VSCODE_CANDIDATES = [
  '/usr/local/bin/code',
  '/opt/homebrew/bin/code',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/VSCodium.app/Contents/Resources/app/bin/codium',
];
let _vscodeBin; // undefined = 未探测, null = 不存在, string = 路径

function detectVSCode() {
  if (_vscodeBin !== undefined) return _vscodeBin;
  for (const p of VSCODE_CANDIDATES) {
    try { if (fs.existsSync(p)) { _vscodeBin = p; return p; } } catch (_) {}
  }
  // 兜底用 `which`，覆盖自定义 PATH 安装
  try {
    const r = spawnSync('which', ['code'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      _vscodeBin = r.stdout.trim();
      return _vscodeBin;
    }
  } catch (_) {}
  _vscodeBin = null;
  return null;
}

/** 测试用：重置 VS Code 检测缓存 */
function _resetVSCodeCache() { _vscodeBin = undefined; }

/**
 * 根据 resolved 结果构造打开命令。
 * @param {ReturnType<typeof resolveTarget>} resolved
 * @returns {{ cmd: string, args: string[] }}
 */
function buildOpenCommand(resolved) {
  if (resolved.kind === 'url') {
    return { cmd: 'open', args: [resolved.value] };
  }
  const code = detectVSCode();
  if (code) {
    if (resolved.line) {
      const loc = `${resolved.value}:${resolved.line}${resolved.col ? ':' + resolved.col : ''}`;
      return { cmd: code, args: ['-g', loc] };
    }
    return { cmd: code, args: [resolved.value] };
  }
  return { cmd: 'open', args: [resolved.value] };
}

module.exports = {
  resolveTarget,
  buildOpenCommand,
  detectVSCode,
  _resetVSCodeCache,
};
