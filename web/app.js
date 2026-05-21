'use strict';

const state = {
  projects: [],
  selectedSlug: null,
  detail: null,
  expanded: { in_progress: true, todo: false, review: false, blocked: false, done_today: false },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

async function fetchProjects() {
  const r = await fetch('/api/projects');
  return r.json();
}

async function fetchDetail(slug) {
  const r = await fetch(`/api/projects/${slug}`);
  if (!r.ok) return null;
  return r.json();
}

async function postAction(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? 'POST' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}

function statusLabel(p) {
  if (p.online === 'missing') return '失联';
  if (p.online === 'offline') return '离线';
  if (p.phase === 'executing') return `运行中 #${p.currentTask?.id ?? ''}`;
  if (p.phase === 'sleeping') return '队列空';
  if (p.online === 'active') return '活跃';
  return '等待中';
}

function renderProjects() {
  const list = $('#project-list');
  list.innerHTML = '';
  if (state.projects.length === 0) {
    list.appendChild(el('div', { className: 'project-item' }, '（无已注册项目）'));
    return;
  }
  for (const p of state.projects) {
    const item = el('div', {
      className: 'project-item' + (p.slug === state.selectedSlug ? ' active' : ''),
      onclick: () => selectProject(p.slug),
    },
      el('div', { className: 'name' },
        el('span', { className: `dot ${p.online}` }), p.name,
      ),
      el('div', { className: 'summary' }, statusLabel(p)),
    );
    list.appendChild(item);
  }
}

function renderTaskRow(t, group) {
  const actions = [];
  if (group === 'todo') {
    actions.push(el('button', {
      className: 'btn',
      onclick: () => changePriority(t.id),
    }, '改优先级'));
    actions.push(el('button', {
      className: 'btn danger',
      onclick: () => skipTask(t.id),
    }, 'skip'));
  }
  return el('div', { className: 'task-row' },
    el('div', { className: 'task-desc' },
      el('div', null, `#${t.id} ${t.desc}`),
      el('div', { className: 'meta', style: 'font-size:11px;color:var(--text-dim)' },
        `scope: ${t.scope}  ·  优先级: ${t.priority}` + (t.risk ? `  ·  风险: ${t.risk}` : '')
        + (t.question ? `  ·  疑问: ${t.question}` : ''),
      ),
    ),
    el('div', { className: 'task-actions' }, ...actions),
  );
}

function renderGroup(label, key, items) {
  const expanded = state.expanded[key] || items.length > 0 && key === 'in_progress';
  return el('div', { className: 'group' + (expanded ? ' expanded' : '') },
    el('div', {
      className: 'group-header',
      onclick: (e) => { state.expanded[key] = !state.expanded[key]; renderDetail(); },
    },
      el('span', { className: 'group-title' }, label),
      el('span', { className: 'group-count' }, `(${items.length})`),
    ),
    el('div', { className: 'group-body' },
      ...items.map(t => renderTaskRow(t, key)),
    ),
  );
}

function renderDetail() {
  $('#detail-empty').style.display = state.detail ? 'none' : 'block';
  const c = $('#detail-content');
  c.style.display = state.detail ? 'block' : 'none';
  if (!state.detail) return;

  const { project: p, tasks } = state.detail;
  c.innerHTML = '';
  c.appendChild(el('h2', null, p.name, ' ', el('span', { className: `dot ${p.online}` })));
  c.appendChild(el('div', { className: 'meta' },
    `${statusLabel(p)} · 上次心跳: ${p.lastHeartbeat ? new Date(p.lastHeartbeat).toLocaleString() : '—'} · 模型: ${p.lastModel ?? '—'}`,
  ));

  if (p.currentTask) {
    c.appendChild(el('div', { className: 'current-task' },
      el('div', { className: 'label' }, '正在执行'),
      el('div', { className: 'title' }, `#${p.currentTask.id} ${p.currentTask.desc}`),
      el('div', { className: 'tags' },
        el('span', { className: 'tag' }, `scope: ${p.currentTask.scope ?? '—'}`),
        el('span', { className: 'tag' }, `优先级: ${p.currentTask.priority ?? '—'}`),
      ),
    ));
  }

  c.appendChild(renderGroup('进行中', 'in_progress', tasks.in_progress));
  c.appendChild(renderGroup('待办', 'todo', tasks.todo));
  c.appendChild(renderGroup('待 review', 'review', tasks.review));
  c.appendChild(renderGroup('阻塞', 'blocked', tasks.blocked));
  c.appendChild(renderGroup('今日完成', 'done_today', tasks.done_today));

  const pauseBtn = el('button', {
    className: 'btn primary',
    onclick: () => p.paused ? resumeProject() : pauseProject(),
  }, p.paused ? `resume (原因: ${p.pauseReason})` : 'pause loop');
  c.appendChild(el('div', { className: 'pause-bar' + (p.paused ? ' paused' : '') }, pauseBtn));
}

async function refreshProjects() {
  try {
    const data = await fetchProjects();
    state.projects = data.projects;
    renderProjects();
    if (state.selectedSlug) await refreshDetail();
  } catch (e) {
    console.error('refresh failed', e);
  }
}

async function refreshDetail() {
  if (!state.selectedSlug) return;
  state.detail = await fetchDetail(state.selectedSlug);
  renderDetail();
}

async function selectProject(slug) {
  state.selectedSlug = slug;
  await refreshDetail();
  renderProjects();
}

async function skipTask(id) {
  if (!confirm(`确认跳过任务 #${id}？`)) return;
  await postAction(`/api/projects/${state.selectedSlug}/skip`, { id });
  await refreshProjects();
}

async function changePriority(id) {
  const p = prompt('改为优先级（高/中/低）');
  if (!['高', '中', '低'].includes(p)) return;
  await postAction(`/api/projects/${state.selectedSlug}/priority`, { id, priority: p });
  await refreshProjects();
}

async function pauseProject() {
  const reason = prompt('暂停原因？', '面板手动暂停');
  if (reason == null) return;
  await postAction(`/api/projects/${state.selectedSlug}/pause`, { reason });
  await refreshProjects();
}

async function resumeProject() {
  await postAction(`/api/projects/${state.selectedSlug}/resume`);
  await refreshProjects();
}

refreshProjects();
setInterval(refreshProjects, 5000);
