'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { list: registryList, remove: registryRemove } = require('../lib/registry.cjs');
const { readRows, withWorkbook, SHEET_IN_PROGRESS, SHEET_ARCHIVED, colIndex } = require('../lib/workbook.cjs');
const { STATES, PRIORITY_ORDER } = require('../lib/states.cjs');
const { readHeartbeat } = require('../lib/heartbeat.cjs');
const { readPaused, setPaused, clearPaused } = require('../lib/paused.cjs');
const { localDateStr } = require('../lib/datetime.cjs');
const { loadProjectConfig } = require('../lib/config.cjs');
const { addRowCore } = require('./add-row.cjs');

const WEB_ROOT = path.join(__dirname, '..', 'web');

/** slug 合法格式：小写字母、数字、连字符 */
const SLUG_RE = /^[a-z0-9-]+$/;

/** 路由详情接口匹配正则 */
const DETAIL_ROUTE_RE = /^\/api\/projects\/([^/]+)$/;

/** 任务列表 pick 字段（基础） */
const TASK_PICK_FIELDS = ['id', 'desc', 'scope', 'priority', 'ctime', 'note', 'risk', 'question'];

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
 * 在 withWorkbook 内定位 taskId 对应的 row，校验 expectedStatus，
 * 再调用 mutateFn(row) 做字段修改，最后 row.commit()。
 *
 * @param {{ root: string }} entry 项目注册信息
 * @param {number|string} taskId 任务 id
 * @param {string|null} expectedStatus null = 不校验状态
 * @param {(row: import('exceljs').Row) => void} mutateFn 修改行的函数
 * @returns {Promise<{ notFound?: true, conflict?: true }>} 空对象表示成功
 */
async function mutateTaskRow(entry, taskId, expectedStatus, mutateFn) {
  const xlsxPath = path.join(entry.root, '.tasks', 'tasks.xlsx');

  // 先读出来找 rowNumber 和当前 status（在锁外，避免长时持锁）
  const rows = await readRows(xlsxPath, SHEET_IN_PROGRESS);
  const target = rows.find(r => String(r.id) === String(taskId));
  if (!target) return { notFound: true };
  if (expectedStatus !== null && target.status !== expectedStatus) return { conflict: true };

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
 * body: { id }  待办 → 跳过；非待办 → 409；id 不存在 → 404
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

  const result = await mutateTaskRow(entry, taskId, STATES.TODO, row => {
    row.getCell(colIndex('status')).value = STATES.SKIPPED;
  });

  if (result.notFound) return sendJson(res, 404, { error: 'task not found' });
  if (result.conflict) return sendJson(res, 409, { error: 'task is not in TODO state' });
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
 * body: { desc, scope, priority?, note? }
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
    });
    sendJson(res, 200, { ok: true, row: result });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message) });
  }
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
  send(res, 200, fs.readFileSync(filePath), MIME[ext] || 'application/octet-stream');
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

  const addRowM = pathname.match(/^\/api\/projects\/([^/]+)\/add-row$/);
  if (addRowM && req.method === 'POST') {
    handleAddRow(req, res, addRowM[1]).catch(err => sendJson(res, 500, { error: String(err.message) }));
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

module.exports = { startServer };
