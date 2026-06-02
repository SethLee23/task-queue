'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { spawn, execFileSync: realExecFileSync } = require('node:child_process');

/**
 * tmux 子进程调用钩子。测试用 __setExecFileSyncImpl 注入 mock，传 null 还原默认。
 * 仅 handleScanNow 走这条路；其他业务逻辑继续直接用 child_process。
 */
let execFileSyncImpl = realExecFileSync;
function __setExecFileSyncImpl(fn) {
  execFileSyncImpl = fn || realExecFileSync;
}
const { list: registryList, remove: registryRemove, update: registryUpdate, VALID_MODELS } = require('../lib/registry.cjs');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED, colIndex } = require('../lib/workbook.cjs');
const { STATES, PRIORITY_ORDER } = require('../lib/states.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { readPaused, setPaused, clearPaused } = require('../lib/paused.cjs');
const { readWakeNow, setWakeNow } = require('../lib/wake.cjs');
const { localDateStr } = require('../lib/datetime.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { addRowCore } = require('./add-row.cjs');
const { replyCore } = require('./reply.cjs');
const { markDoneCore } = require('./mark-done.cjs');
const { setTaskModelCore } = require('./set-task-model.cjs');
const { resolveTarget, buildOpenCommand } = require('../lib/open-target.cjs');

const WEB_ROOT = path.join(__dirname, '..', 'web');

/** slug 合法格式：小写字母、数字、连字符 */
const SLUG_RE = /^[a-z0-9-]+$/;

/** 路由详情接口匹配正则 */
const DETAIL_ROUTE_RE = /^\/api\/projects\/([^/]+)$/;

/** 任务列表 pick 字段（基础） */
const TASK_PICK_FIELDS = ['id', 'desc', 'scope', 'priority', 'ctime', 'note', 'risk', 'question', 'model', 'tags', 'checklist'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

/** 合法优先级集合 */
const VALID_PRIORITIES = new Set(PRIORITY_ORDER);

/**
 * 读取并解析请求 body 为 JSON 对象。
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (e) { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * 带最大字节限制的 readJsonBody，用于上传类大 body 端点。
 * 超过 maxBytes 立即停止累积并 reject 413 错误,但不 destroy stream —
 * 让请求自然 drain 完,避免抢在 sendJson 之前关闭 socket 导致客户端拿不到响应。
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<object>}
 */
function readJsonBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        aborted = true;
        raw = '';
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(raw || '{}')); }
      catch (e) { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', err => { if (!aborted) reject(err); });
  });
}

/**
 * 在 withWorkbook 内定位 taskId 对应的 row，校验 expectedStatus，
 * 再调用 mutateFn(row) 做字段修改，最后 row.commit()。
 *
 * @param {{ root: string }} entry 项目注册信息
 * @param {number|string} taskId 任务 id
 * @param {string|string[]|null} expectedStatus null = 不校验；string = 单状态；string[] = 任一状态
 * @param {(row: import('exceljs').Row) => void} mutateFn 修改行的函数
 * @returns {Promise<{ notFound?: true, conflict?: true }>} 空对象表示成功
 */
async function mutateTaskRow(entry, taskId, expectedStatus, mutateFn) {
  const xlsxPath = path.join(entry.root, '.tasks', 'tasks.xlsx');

  // 先读出来找 rowNumber 和当前 status（在锁外，避免长时持锁）
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(taskId));
  if (!target) return { notFound: true };
  if (expectedStatus !== null) {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!allowed.includes(target.status)) return { conflict: true };
  }

  await withWorkbook(xlsxPath, async wb => {
    const ws = wb.getWorksheet(SHEET_IN_PROGRESS);
    const row = ws.getRow(target._rowNumber);
    mutateFn(row);
    row.commit();
  });
  return {};
}

/**
 * 处理 POST /api/projects/:slug/skip
 * body: { id }  待办 / 待 review / 阻塞 → 跳过；其余状态 → 409；id 不存在 → 404
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleSkip(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body || body.id == null) return sendJson(res, 400, { error: 'id is required' });
  const taskId = body.id;

  const result = await mutateTaskRow(
    entry,
    taskId,
    [STATES.TODO, STATES.REVIEW, STATES.BLOCKED],
    row => {
      row.getCell(colIndex('status')).value = STATES.SKIPPED;
    },
  );

  if (result.notFound) return sendJson(res, 404, { error: 'task not found' });
  if (result.conflict) return sendJson(res, 409, { error: 'task not skippable (must be 待办 / 待 review / 阻塞)' });
  sendJson(res, 200, { ok: true });
}

/**
 * 处理 POST /api/projects/:slug/priority
 * body: { id, priority }  改待办任务优先级；非法 priority → 400；id 不存在 → 404
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handlePriority(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body || body.id == null) return sendJson(res, 400, { error: 'id is required' });
  const { id: taskId, priority } = body;
  if (!priority || !VALID_PRIORITIES.has(priority)) {
    return sendJson(res, 400, { error: `invalid priority, must be one of: ${PRIORITY_ORDER.join(', ')}` });
  }

  const result = await mutateTaskRow(entry, taskId, STATES.TODO, row => {
    row.getCell(colIndex('priority')).value = priority;
  });

  if (result.notFound) return sendJson(res, 404, { error: 'task not found' });
  if (result.conflict) return sendJson(res, 409, { error: 'task is not in TODO state' });
  sendJson(res, 200, { ok: true });
}

/**
 * 处理 POST /api/projects/:slug/pause
 * body: { reason? }  写 loop-paused 文件，reason 为空时默认"面板暂停"
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handlePause(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => ({}));
  const reason = (body && body.reason) ? String(body.reason) : '面板暂停';
  setPaused(entry.root, reason);
  sendJson(res, 200, { ok: true });
}

/**
 * 处理 POST /api/projects/:slug/resume
 * 删除 loop-paused 文件，恢复运行
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleResume(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  clearPaused(entry.root);
  sendJson(res, 200, { ok: true });
}

/**
 * 处理 POST /api/projects/:slug/wake-now
 * body: { reason? }  写 wake-now 旗子，reason 默认"面板立即执行"
 * 旗子在 loop 下一次唤醒（间隔由 idleSleepSeconds 控制）时被消费，
 * 实际响应延迟 ≤ idleSleepSeconds 秒。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleWakeNow(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => ({}));
  const reason = (body && body.reason) ? String(body.reason) : '面板立即执行';
  setWakeNow(entry.root, reason);
  sendJson(res, 200, { ok: true });
}

/**
 * 把 slug 翻成 tmux session 名。
 * @param {string} slug
 * @returns {string}
 */
function scanSessionName(slug) {
  return `task-queue-loop-${slug}`;
}

/**
 * 处理 POST /api/projects/:slug/scan-now
 * 先 `tmux has-session -t <session>`，存在则 `tmux send-keys -t <session> 扫一下 Enter`
 * 注入到 loop stdin（Claude 立即响应，绕开 ScheduleWakeup 倒计时）；
 * tmux 不可用 / session 不存在则降级写 wake-now 旗子。
 * @param {http.IncomingMessage} _req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleScanNow(_req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const sessionName = scanSessionName(slug);
  try {
    execFileSyncImpl('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
    execFileSyncImpl('tmux', ['send-keys', '-t', sessionName, '扫一下', 'Enter'], { stdio: 'ignore' });
    return sendJson(res, 200, { ok: true, mode: 'tmux', sessionName });
  } catch (_err) {
    setWakeNow(entry.root, '面板立即执行');
    return sendJson(res, 200, { ok: true, mode: 'wake-flag', sessionName });
  }
}

/**
 * 处理 DELETE /api/projects/:slug
 * 从注册表移出项目，不触碰文件系统目录内容（幂等）
 * @param {http.IncomingMessage} _req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleDelete(_req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  registryRemove(slug);
  sendJson(res, 200, { ok: true });
}

/**
 * 处理 POST /api/projects/:slug/add-row
 * body: { desc, scope, priority?, note?, tags?, model? }
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleAddRow(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body || !body.desc || !body.scope) {
    return sendJson(res, 400, { error: 'desc 和 scope 必填' });
  }

  try {
    const result = await addRowCore(entry.root, {
      desc: String(body.desc),
      scope: String(body.scope),
      priority: body.priority ? String(body.priority) : undefined,
      note: body.note ? String(body.note) : '',
      // tags: 接受数组或逗号/竖线分隔字符串，addRowCore 内部 normalizeTags 统一
      tags: body.tags == null ? undefined : body.tags,
      // model: 空串 = 跟项目；undefined = 老前端没带，addRowCore 当空串处理
      model: body.model == null ? undefined : String(body.model),
    });
    sendJson(res, 200, { ok: true, row: result });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
}

/** 允许的图片 MIME → 文件扩展名 */
const ALLOWED_IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** 单张图片最大字节数（解码后） */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 上传请求 body 最大字节数（容纳 base64 膨胀 ~33%） */
const MAX_UPLOAD_BODY_BYTES = 7 * 1024 * 1024;

/**
 * 幂等地把 .tasks/attachments/ 追加到项目 .gitignore，避免附件被误 commit。
 * 文件不存在则创建。任何 IO 失败均吞掉（best-effort）。
 * @param {string} projectRoot
 */
function ensureAttachmentsGitignored(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const wanted = '.tasks/attachments/';
  let content = '';
  try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch (_) { /* 不存在 → 创建 */ }
  const lines = new Set(content.split('\n').map(l => l.trim()));
  // 整目录已被 ignore（init-write 默认行为）→ 不需要再追加
  if (lines.has('.tasks/') || lines.has('.tasks')) return;
  if (lines.has(wanted)) return;
  if (content.length > 0 && !content.endsWith('\n')) content += '\n';
  content += wanted + '\n';
  try { fs.writeFileSync(gitignorePath, content); } catch (_) { /* best-effort */ }
}

/**
 * 处理 POST /api/projects/:slug/upload-image
 * body: { contentType: string, dataBase64: string, filename?: string }
 *
 * 接收前端粘贴/选择的图片二进制（base64 编码),写入 <root>/.tasks/attachments/<ts>-<rand>.<ext>,
 * 返回相对项目根的路径。校验:
 *  - contentType 必在 ALLOWED_IMAGE_TYPES
 *  - 解码后大小 ≤ MAX_IMAGE_BYTES
 *  - body 字节数 ≤ MAX_UPLOAD_BODY_BYTES（早期 abort,防止超大 payload）
 *
 * 首次写入时 best-effort 把 .tasks/attachments/ 加入 .gitignore。
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleUploadImage(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  let body;
  try {
    body = await readJsonBodyCapped(req, MAX_UPLOAD_BODY_BYTES);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }

  const contentType = body && typeof body.contentType === 'string'
    ? body.contentType.toLowerCase().trim()
    : '';
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    return sendJson(res, 400, {
      error: `不支持的图片类型: ${contentType || '(空)'}（仅 png/jpeg/gif/webp）`,
    });
  }
  const ext = ALLOWED_IMAGE_TYPES.get(contentType);

  if (!body.dataBase64 || typeof body.dataBase64 !== 'string') {
    return sendJson(res, 400, { error: 'dataBase64 必填' });
  }

  const buf = Buffer.from(body.dataBase64, 'base64');
  if (buf.length === 0) {
    return sendJson(res, 400, { error: '图片数据为空或 base64 无效' });
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return sendJson(res, 413, {
      error: `图片过大（${buf.length} 字节，上限 ${MAX_IMAGE_BYTES}）`,
    });
  }

  const attachmentsDir = path.join(entry.root, '.tasks', 'attachments');
  try {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  } catch (err) {
    return sendJson(res, 500, { error: `创建 attachments 目录失败: ${err.message}` });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const filename = `${ts}-${rand}.${ext}`;
  const absPath = path.join(attachmentsDir, filename);

  try {
    fs.writeFileSync(absPath, buf);
  } catch (err) {
    return sendJson(res, 500, { error: `写入文件失败: ${err.message}` });
  }

  ensureAttachmentsGitignored(entry.root);

  sendJson(res, 200, {
    ok: true,
    path: `.tasks/attachments/${filename}`,
    bytes: buf.length,
  });
}

/**
 * 处理 POST /api/open
 * body: { target: string, projectRoot?: string }
 *
 * target 可为 http(s):// URL、绝对路径、相对路径（需 projectRoot）、~/path、或带 :line:col 后缀。
 * URL 直接 `open <url>` 走系统默认浏览器；文件类目标优先用 VS Code（检测到才用），否则 fallback `open <path>` 走系统默认关联。
 *
 * 参数通过 spawn 数组传入，避免 shell 注入；
 * 路径解析交给 lib/open-target.cjs，含 .. 逃逸/-/ 开头等护栏。
 * 文件类目标先 fs.existsSync 校验存在，避免静默 spawn 失败。
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleOpen(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  const target = body && typeof body.target === 'string' ? body.target.trim() : '';
  const projectRoot = body && typeof body.projectRoot === 'string' ? body.projectRoot : undefined;
  if (!target) return sendJson(res, 400, { error: 'target 必填' });

  let resolved;
  try {
    resolved = resolveTarget(target, projectRoot);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  if (resolved.kind === 'file' && !fs.existsSync(resolved.value)) {
    return sendJson(res, 404, { error: `路径不存在: ${resolved.value}` });
  }

  const { cmd, args } = buildOpenCommand(resolved);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* ignore — 客户端已收到响应 */ });
    child.unref();
    sendJson(res, 200, { ok: true, opener: cmd });
  } catch (err) {
    sendJson(res, 500, { error: String(err.message) });
  }
}

function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * 处理 GET /api/projects/:slug/loop-command
 * 读 loop-prompt.md，替换 ${PROJECT_ROOT}，输出 tmux 三段启动脚本：
 *   1) 把 prompt 写进 $TMPDIR/tq-loop-<slug>.prompt （heredoc 引号定界符,逐字落盘）
 *   2) `tmux new-session -ds "$SESSION" -c <root> "$SHELL"` 起常驻 session
 *   3) `tmux send-keys ... "claude … '/loop $(cat <prompt-file>)' …" Enter`
 *   4) `tmux attach -t "$SESSION"` 让用户落到 loop 上
 * 这样面板 ⚡ 按钮就能通过 send-keys 把 "扫一下" 直接注入 stdin。
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleLoopCommand(res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const promptPath = path.join(__dirname, '..', 'loop-prompt.md');
  let prompt;
  try {
    prompt = fs.readFileSync(promptPath, 'utf8');
  } catch (err) {
    return sendJson(res, 500, { error: `读取 loop-prompt.md 失败: ${err.message}` });
  }
  prompt = prompt.replace(/\$\{PROJECT_ROOT\}/g, entry.root);
  // 去掉末尾多余空行，heredoc 看起来干净
  prompt = prompt.replace(/\s+$/, '');

  const sessionName = scanSessionName(slug);
  const rootQ = shellSingleQuote(entry.root);
  // send-keys 这一行外层是 bash 双引号串，里面：
  //   - \"   → 字面 "
  //   - \$(  → 字面 $(  （让内层 shell 自己执行 $(cat …) ）
  //   - $PROMPT_FILE 由外层 bash 展开成真路径
  const sendKeysLine =
    'tmux send-keys -t "$SESSION" ' +
    '"claude --dangerously-skip-permissions \\"/loop \\$(cat \'$PROMPT_FILE\')\\"" ' +
    'Enter';

  const command = [
    `SESSION='${sessionName}'`,
    `PROMPT_FILE="\${TMPDIR:-/tmp}/tq-loop-${slug}.prompt"`,
    `cat > "$PROMPT_FILE" <<'TQ_PROMPT_END'`,
    prompt,
    `TQ_PROMPT_END`,
    `tmux new-session -ds "$SESSION" -c ${rootQ} "$SHELL"`,
    sendKeysLine,
    `tmux attach -t "$SESSION"`,
  ].join('\n');

  sendJson(res, 200, { command, projectRoot: entry.root, sessionName });
}

/**
 * 处理 POST /api/projects/:slug/reply
 * body: { id, reply, resume?: bool }
 * 给指定任务的 note 顶部追加用户答复；resume=true 时把 blocked/review 状态转回 todo。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleReply(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body || body.id == null) return sendJson(res, 400, { error: 'id 必填' });
  if (!body.reply || !String(body.reply).trim()) {
    return sendJson(res, 400, { error: 'reply 内容不能为空' });
  }

  try {
    const result = await replyCore(entry.root, {
      id: body.id,
      reply: String(body.reply),
      resume: !!body.resume,
    });
    sendJson(res, 200, { ok: true, task: result });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
}

/**
 * 处理 POST /api/projects/:slug/mark-done
 * body: { id, summary } 把 待review / 阻塞 任务手动标记为已完成并归档。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleMarkDone(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body || body.id == null) return sendJson(res, 400, { error: 'id 必填' });
  if (!body.summary || !String(body.summary).trim()) {
    return sendJson(res, 400, { error: 'summary 不能为空' });
  }

  try {
    const result = await markDoneCore(entry.root, {
      id: body.id,
      summary: String(body.summary),
    });
    sendJson(res, 200, { ok: true, task: result });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
}

/**
 * 处理 POST /api/projects/:slug/desired-model
 * body: { model } 项目级默认 worker 模型，subagent 派发时用
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleDesiredModel(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  const model = body && typeof body.model === 'string' ? body.model.trim() : '';
  if (!VALID_MODELS.includes(model)) {
    return sendJson(res, 400, { error: `model 必须为 ${VALID_MODELS.join('/')}` });
  }

  try {
    const updated = registryUpdate(slug, { desiredModel: model });
    sendJson(res, 200, { ok: true, desiredModel: updated.desiredModel });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
}

/**
 * 处理 POST /api/projects/:slug/hidden
 * body: { hidden: boolean } 把项目从主列表隐藏/显示
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleHidden(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body || typeof body.hidden !== 'boolean') {
    return sendJson(res, 400, { error: 'hidden 必须是 boolean' });
  }

  try {
    const updated = registryUpdate(slug, { hidden: body.hidden });
    sendJson(res, 200, { ok: true, hidden: updated.hidden });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
}

/**
 * 处理 POST /api/projects/:slug/tasks/:id/model
 * body: { model } 任务级覆盖，model 为空字符串清除覆盖（回退项目级）
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 * @param {string} rawTaskId
 */
async function handleTaskModel(req, res, rawSlug, rawTaskId) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'invalid body' });
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (model && !VALID_MODELS.includes(model)) {
    return sendJson(res, 400, { error: `model 必须为 ${VALID_MODELS.join('/')} 或空字符串清除覆盖` });
  }

  try {
    const result = await setTaskModelCore(entry.root, { id: rawTaskId, model });
    sendJson(res, 200, { ok: true, task: result });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
}

/**
 * 处理 POST /api/projects/:slug/tasks/:id/checklist
 * body: { items: [{text, done}, ...] } 全量替换 checklist
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 * @param {string} rawTaskId
 */
async function handleTaskChecklist(req, res, rawSlug, rawTaskId) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body || !Array.isArray(body.items)) {
    return sendJson(res, 400, { error: 'body 必须含 items 数组' });
  }

  try {
    const { applyChecklistMutation } = require('../lib/checklist-apply.cjs');
    const { parseChecklist } = require('../lib/checklist.cjs');
    // parseChecklist 既清洗又验证: text 必填,done 转 boolean,丢弃空 text
    const next = parseChecklist(body.items);
    const result = await applyChecklistMutation(entry.root, rawTaskId, () => next);
    sendJson(res, 200, { ok: true, id: result.id, items: result.after });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
}

/**
 * 处理 GET /api/projects/:slug/history?days=30&limit=500
 * 返回归档表(已完结)中过去 N 天的 done 任务，按 ftime 倒序。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
async function handleGetHistory(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug format' });

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return sendJson(res, 404, { error: 'project not found' });

  const parsed = url.parse(req.url, true);
  let days = Number(parsed.query?.days);
  if (!Number.isFinite(days) || days <= 0) days = 30;
  if (days > 365) days = 365;
  let limit = Number(parsed.query?.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 500;
  if (limit > 5000) limit = 5000;

  const xlsxPath = path.join(entry.root, '.tasks', 'tasks.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    return sendJson(res, 200, { items: [], total: 0, days, limit });
  }

  const archRows = await readRows(xlsxPath, SHEET_ARCHIVED);
  const cutoffMs = Date.now() - days * 86400000;
  const items = [];
  for (const row of archRows) {
    if (row.status !== STATES.DONE || !row.ftime) continue;
    const d = row.ftime instanceof Date ? row.ftime : new Date(/** @type {string} */ (row.ftime));
    const t = d.getTime();
    if (!Number.isFinite(t) || t < cutoffMs) continue;
    const picked = pickFields(row, TASK_PICK_FIELDS);
    picked.ftime = d.toISOString();
    items.push(picked);
  }
  items.sort((a, b) => String(b.ftime || '').localeCompare(String(a.ftime || '')));
  const total = items.length;
  if (items.length > limit) items.length = limit;
  sendJson(res, 200, { items, total, days, limit });
}

/**
 * 处理 POST /api/cleanup-missing
 * 遍历注册表，把 root 不存在或 .tasks 目录缺失的条目移出注册表，
 * 不触碰任何文件系统目录内容。
 * @param {http.IncomingMessage} _req
 * @param {http.ServerResponse} res
 */
async function handleCleanupMissing(_req, res) {
  const removed = [];
  for (const entry of registryList()) {
    if (!fs.existsSync(entry.root) || !fs.existsSync(path.join(entry.root, '.tasks'))) {
      registryRemove(entry.slug);
      removed.push({ slug: entry.slug, root: entry.root });
    }
  }
  sendJson(res, 200, { ok: true, removed, count: removed.length });
}

/**
 * 判断 ftime 是否属于今天（本地时区）。
 * ftime 可能是 Date 对象、ISO string 或空值。
 * @param {unknown} ftime
 * @param {string} today YYYY-MM-DD 格式的今日日期
 * @returns {boolean}
 */
function isToday(ftime, today) {
  if (!ftime) return false;
  const d = ftime instanceof Date ? ftime : new Date(/** @type {string} */ (ftime));
  if (Number.isNaN(d.getTime())) return false;
  return localDateStr(d) === today;
}

/**
 * 根据心跳数据推导 online 状态。
 * @param {string} root 项目根目录
 * @param {object|null} hb 心跳数据
 * @returns {'active'|'idle'|'offline'|'missing'}
 */
function deriveOnline(root, hb) {
  if (!fs.existsSync(root) || !fs.existsSync(path.join(root, '.tasks'))) return 'missing';
  if (!hb || !hb.ts) return 'offline';
  const ageMs = Date.now() - new Date(hb.ts).getTime();
  if (ageMs > 90 * 60 * 1000) return 'offline';
  if (hb.phase === 'executing' || ageMs < 5 * 60 * 1000) return 'active';
  return 'idle';
}

/**
 * 聚合单个项目的状态信息。
 * @param {{ slug: string, root: string, name: string, registeredAt: string }} entry
 * @returns {Promise<object>}
 */
async function aggregateProject(entry) {
  const { root } = entry;

  // 检查项目目录或 .tasks 子目录是否存在
  if (!fs.existsSync(root) || !fs.existsSync(path.join(root, '.tasks'))) {
    return {
      ...entry,
      online: 'missing',
      phase: null,
      lastHeartbeat: null,
      lastModel: null,
      paused: false,
      pauseReason: null,
      wakeNow: false,
      wakeNowReason: null,
      counts: { todo: 0, in_progress: 0, review: 0, blocked: 0, done_today: 0 },
      currentTask: null,
      lastFinished: null,
    };
  }

  const xlsxPath = path.join(root, '.tasks', 'tasks.xlsx');
  const today = localDateStr();

  let counts = { todo: 0, in_progress: 0, review: 0, blocked: 0, done_today: 0 };
  let inProgRows = [];
  if (fs.existsSync(xlsxPath)) {
    inProgRows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
    const archived = await readRows(xlsxPath, SHEET_ARCHIVED);
    counts = {
      todo:        inProgRows.filter(r => r.status === STATES.TODO).length,
      in_progress: inProgRows.filter(r => r.status === STATES.IN_PROGRESS).length,
      review:      inProgRows.filter(r => r.status === STATES.REVIEW).length,
      blocked:     inProgRows.filter(r => r.status === STATES.BLOCKED).length,
      done_today:  archived.filter(r => r.status === STATES.DONE && isToday(r.ftime, today)).length,
    };
  }

  const hb = readHeartbeat(root);
  const pauseReason = readPaused(root);
  const wakeReason = readWakeNow(root);

  // currentTask：补充 scope 和 priority，从 in_progress sheet 中匹配
  let currentTask = null;
  if (hb && hb.currentTaskId != null) {
    const inProgressRow = inProgRows.find(
      r => r.status === STATES.IN_PROGRESS && String(r.id) === String(hb.currentTaskId)
    );
    currentTask = {
      id: hb.currentTaskId,
      desc: hb.currentTaskDesc,
      scope: inProgressRow ? (inProgressRow.scope ?? null) : null,
      priority: inProgressRow ? (inProgressRow.priority ?? null) : null,
    };
  }

  // lastFinished：从心跳取 lastFinishedId / lastFinishedAt
  const lastFinished = hb && hb.lastFinishedId != null
    ? { id: hb.lastFinishedId, at: hb.lastFinishedAt }
    : null;

  return {
    ...entry,
    online: deriveOnline(root, hb),
    phase: hb ? (hb.phase ?? null) : null,
    lastHeartbeat: hb ? (hb.ts ?? null) : null,
    lastModel: hb ? (hb.model ?? null) : null,
    paused: pauseReason !== null,
    pauseReason: pauseReason,
    wakeNow: wakeReason !== null,
    wakeNowReason: wakeReason,
    counts,
    currentTask,
    lastFinished,
  };
}

/**
 * 处理 GET /api/projects 请求，返回所有注册项目的聚合状态。
 * @param {http.ServerResponse} res
 */
async function handleGetProjects(res) {
  const entries = registryList();
  const projects = await Promise.all(entries.map(aggregateProject));
  sendJson(res, 200, { projects });
}

/**
 * 从行对象中 pick 指定字段，返回新对象。
 * @param {object} row
 * @param {string[]} fields
 * @returns {object}
 */
function pickFields(row, fields) {
  const out = {};
  for (const f of fields) {
    if (f in row) out[f] = row[f];
  }
  return out;
}

/**
 * 构建项目详情数据：聚合 project 信息 + 分组任务列表。
 * @param {{ slug: string, root: string, name: string, registeredAt: string }} entry
 * @returns {Promise<{ project: object, tasks: object }>}
 */
async function buildProjectDetail(entry) {
  const project = await aggregateProject(entry);

  let scopes = [];
  try {
    const cfg = loadProjectConfig(entry.root);
    scopes = Object.keys(cfg.scopes || {});
  } catch (_) {
    // 配置缺失或解析失败时返回空数组，前端据此禁用新增按钮
  }

  const xlsxPath = path.join(entry.root, '.tasks', 'tasks.xlsx');
  const today = localDateStr();

  let todo = [];
  let in_progress = [];
  let review = [];
  let blocked = [];
  let done_today = [];

  if (fs.existsSync(xlsxPath)) {
    const inRows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
    const archRows = await readRows(xlsxPath, SHEET_ARCHIVED);

    for (const row of inRows) {
      const picked = pickFields(row, TASK_PICK_FIELDS);
      if (row.status === STATES.TODO) todo.push(picked);
      else if (row.status === STATES.IN_PROGRESS) in_progress.push(picked);
      else if (row.status === STATES.REVIEW) review.push(picked);
      else if (row.status === STATES.BLOCKED) blocked.push(picked);
    }

    for (const row of archRows) {
      if (row.status === STATES.DONE && isToday(row.ftime, today)) {
        const picked = pickFields(row, TASK_PICK_FIELDS);
        picked.ftime = row.ftime;
        done_today.push(picked);
      }
    }
    // 最新完成在前 —— 用户看 done strip 第一眼就是最近 Claude 干的活。
    // ftime 是 ISO 字符串(commands/done.cjs 写的 new Date().toISOString()),字符串降序即时间降序。
    done_today.sort((a, b) => String(b.ftime || '').localeCompare(String(a.ftime || '')));
  }

  return { project, scopes, tasks: { in_progress, todo, review, blocked, done_today } };
}

/**
 * 处理 GET /api/projects/:slug 请求，返回项目详情与分组任务列表。
 * @param {http.ServerResponse} res
 * @param {string} rawSlug url.parse pathname 中提取的原始 slug 片段（可能含 percent 编码）
 */
async function handleApiProjectDetail(res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) {
    return sendJson(res, 400, { error: 'invalid slug format' });
  }
  const entry = registryList().find(p => p.slug === slug);
  if (!entry) {
    return sendJson(res, 404, { error: 'project not found' });
  }
  const detail = await buildProjectDetail(entry);
  sendJson(res, 200, detail);
}

/** GET /api/projects/:slug/file?path=.tasks/attachments/xxx 允许的 ext → MIME */
const ATTACH_FILE_MIME = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

/**
 * 处理 GET /api/projects/:slug/file?path=.tasks/attachments/xxx
 *
 * 用于前端 <img src> inline 显示任务附件。严格限制:
 *  - path 必须是相对路径,且以 .tasks/attachments/ 开头
 *  - 解析后绝对路径必须仍位于 <root>/.tasks/attachments/ 下（防 .. 逃逸）
 *  - 扩展名必须在 ATTACH_FILE_MIME 白名单（防当成静态服务器分发任意文件）
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawSlug
 */
function handleGetAttachment(req, res, rawSlug) {
  const slug = decodeURIComponent(rawSlug);
  if (!SLUG_RE.test(slug)) return send(res, 400, 'invalid slug');

  const entry = registryList().find(p => p.slug === slug);
  if (!entry) return send(res, 404, 'project not found');

  const parsed = url.parse(req.url, true);
  const relPath = parsed.query && typeof parsed.query.path === 'string' ? parsed.query.path : '';
  if (!relPath) return send(res, 400, 'path 必填');

  if (!relPath.startsWith('.tasks/attachments/')) {
    return send(res, 403, 'forbidden (仅允许 .tasks/attachments/ 下文件)');
  }

  const absPath = path.resolve(entry.root, relPath);
  const allowedPrefix = path.resolve(entry.root, '.tasks', 'attachments') + path.sep;
  if (!(absPath + path.sep).startsWith(allowedPrefix) && absPath + path.sep !== allowedPrefix) {
    return send(res, 403, 'forbidden (path escape)');
  }

  const ext = path.extname(absPath).toLowerCase();
  const mime = ATTACH_FILE_MIME[ext];
  if (!mime) return send(res, 415, 'unsupported file type');

  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    return send(res, 404, 'not found');
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(fs.readFileSync(absPath));
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function serveStatic(req, res) {
  let urlPath = url.parse(req.url).pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(WEB_ROOT, urlPath));
  if (!filePath.startsWith(WEB_ROOT)) {
    return send(res, 403, 'forbidden');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return send(res, 404, 'not found');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(fs.readFileSync(filePath));
}

function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const { pathname } = parsed;

  if (pathname === '/api/projects' && req.method === 'GET') {
    handleGetProjects(res).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  if (pathname === '/api/cleanup-missing' && req.method === 'POST') {
    handleCleanupMissing(req, res).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  if (pathname === '/api/open' && req.method === 'POST') {
    handleOpen(req, res).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const skipM = pathname.match(/^\/api\/projects\/([^/]+)\/skip$/);
  if (skipM && req.method === 'POST') {
    handleSkip(req, res, skipM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const prioM = pathname.match(/^\/api\/projects\/([^/]+)\/priority$/);
  if (prioM && req.method === 'POST') {
    handlePriority(req, res, prioM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const pauseM = pathname.match(/^\/api\/projects\/([^/]+)\/pause$/);
  if (pauseM && req.method === 'POST') {
    handlePause(req, res, pauseM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const resumeM = pathname.match(/^\/api\/projects\/([^/]+)\/resume$/);
  if (resumeM && req.method === 'POST') {
    handleResume(req, res, resumeM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const wakeM = pathname.match(/^\/api\/projects\/([^/]+)\/wake-now$/);
  if (wakeM && req.method === 'POST') {
    handleWakeNow(req, res, wakeM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const scanM = pathname.match(/^\/api\/projects\/([^/]+)\/scan-now$/);
  if (scanM && req.method === 'POST') {
    handleScanNow(req, res, scanM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const addRowM = pathname.match(/^\/api\/projects\/([^/]+)\/add-row$/);
  if (addRowM && req.method === 'POST') {
    handleAddRow(req, res, addRowM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const uploadImgM = pathname.match(/^\/api\/projects\/([^/]+)\/upload-image$/);
  if (uploadImgM && req.method === 'POST') {
    handleUploadImage(req, res, uploadImgM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const fileM = pathname.match(/^\/api\/projects\/([^/]+)\/file$/);
  if (fileM && req.method === 'GET') {
    try { handleGetAttachment(req, res, fileM[1]); }
    catch (err) { sendJson(res, 500, { error: String(err.message) }); }
    return;
  }

  const loopCmdM = pathname.match(/^\/api\/projects\/([^/]+)\/loop-command$/);
  if (loopCmdM && req.method === 'GET') {
    handleLoopCommand(res, loopCmdM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const replyM = pathname.match(/^\/api\/projects\/([^/]+)\/reply$/);
  if (replyM && req.method === 'POST') {
    handleReply(req, res, replyM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const markDoneM = pathname.match(/^\/api\/projects\/([^/]+)\/mark-done$/);
  if (markDoneM && req.method === 'POST') {
    handleMarkDone(req, res, markDoneM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const desiredModelM = pathname.match(/^\/api\/projects\/([^/]+)\/desired-model$/);
  if (desiredModelM && req.method === 'POST') {
    handleDesiredModel(req, res, desiredModelM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const hiddenM = pathname.match(/^\/api\/projects\/([^/]+)\/hidden$/);
  if (hiddenM && req.method === 'POST') {
    handleHidden(req, res, hiddenM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const taskModelM = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/model$/);
  if (taskModelM && req.method === 'POST') {
    handleTaskModel(req, res, taskModelM[1], taskModelM[2]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const checklistM = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/checklist$/);
  if (checklistM && req.method === 'POST') {
    handleTaskChecklist(req, res, checklistM[1], checklistM[2]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const historyM = pathname.match(/^\/api\/projects\/([^/]+)\/history$/);
  if (historyM && req.method === 'GET') {
    handleGetHistory(req, res, historyM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  const detailMatch = DETAIL_ROUTE_RE.exec(pathname);
  if (detailMatch && req.method === 'DELETE') {
    handleDelete(req, res, detailMatch[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }
  if (detailMatch && req.method === 'GET') {
    handleApiProjectDetail(res, detailMatch[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
    return;
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'API not implemented yet' });
  }
  serveStatic(req, res);
}

/**
 * 启动 dashboard HTTP 服务器。
 * @param {{ port?: number, host?: string }} options
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
async function startServer({ port = 5732, host = '127.0.0.1' } = {}) {
  const server = http.createServer(handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    async close() {
      await new Promise(r => server.close(r));
    },
  };
}

module.exports = { startServer, __setExecFileSyncImpl };
