'use strict';

const state = {
  projects: [],
  selectedSlug: null,
  detail: null,
  doneCollapsed: true,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
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
  const visible = state.projects.filter(p => p.online !== 'missing');
  const hiddenCount = state.projects.length - visible.length;

  if (visible.length === 0) {
    list.appendChild(el('div', { className: 'project-item' }, '（无已注册项目）'));
  } else {
    for (const p of visible) {
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

  if (hiddenCount > 0) {
    list.appendChild(el('div', { className: 'hidden-hint' },
      el('span', null, `${hiddenCount} 个失联项目已隐藏`),
      el('button', {
        className: 'btn',
        onclick: () => cleanupMissing(hiddenCount),
      }, '清理'),
    ));
  }
}

function renderCard(t, group) {
  const chips = [
    el('span', { className: 'chip' }, t.scope || '—'),
    el('span', { className: `chip prio-${t.priority || '中'}` }, t.priority || '中'),
  ];
  if (t.risk) chips.push(el('span', { className: 'chip risk', title: t.risk }, '⚠ 风险'));
  if (t.question) chips.push(el('span', { className: 'chip question', title: t.question }, '? 疑问'));

  const children = [
    el('div', { className: 'card-desc' },
      el('span', { className: 'card-id' }, `#${t.id}`),
      t.desc || '',
    ),
    el('div', { className: 'card-chips' }, ...chips),
  ];

  const extra = group === 'review' ? t.risk : group === 'blocked' ? t.question : '';
  if (extra) {
    children.push(el('div', { className: 'card-extra', title: extra }, extra));
  }

  if (group === 'todo') {
    children.push(el('div', { className: 'card-actions' },
      el('button', { className: 'btn', onclick: () => changePriority(t.id) }, '改优先级'),
      el('button', { className: 'btn danger', onclick: () => skipTask(t.id) }, 'skip'),
    ));
  }

  return el('div', { className: 'card' }, ...children);
}

function renderColumn(label, key, items) {
  return el('div', { className: 'column' },
    el('div', { className: 'column-header' },
      el('span', null, label),
      el('span', { className: 'col-count' }, String(items.length)),
    ),
    el('div', { className: 'column-body' },
      ...items.map(t => renderCard(t, key)),
    ),
  );
}

function renderDoneStrip(items) {
  const collapsed = state.doneCollapsed;
  return el('div', { className: 'done-strip' + (collapsed ? ' collapsed' : '') },
    el('div', {
      className: 'done-header',
      onclick: () => { state.doneCollapsed = !state.doneCollapsed; renderDetail(); },
    },
      el('span', null, `今日完成 (${items.length})`),
      el('span', null, collapsed ? '▸ 展开' : '▾ 折叠'),
    ),
    el('div', { className: 'done-body' },
      ...items.map(t => el('div', { className: 'done-item', title: t.desc },
        el('span', { className: 'done-id' }, `#${t.id}`),
        (t.desc || '').slice(0, 40) + ((t.desc || '').length > 40 ? '…' : ''),
      )),
    ),
  );
}

function renderDetail() {
  $('#detail-empty').style.display = state.detail ? 'none' : 'block';
  const c = $('#detail-content');
  c.style.display = state.detail ? 'flex' : 'none';
  if (!state.detail) return;

  const { project: p, tasks } = state.detail;
  c.innerHTML = '';

  const pauseBtn = el('button', {
    className: 'btn' + (p.paused ? '' : ' primary'),
    onclick: () => p.paused ? resumeProject() : pauseProject(),
  }, p.paused ? `resume (${p.pauseReason || '已暂停'})` : 'pause loop');

  c.appendChild(el('div', { className: 'detail-header' },
    el('div', null,
      el('div', { className: 'title-line' },
        el('span', { className: `dot ${p.online}` }),
        el('h2', null, p.name),
      ),
      el('div', { className: 'meta' },
        `${statusLabel(p)} · 心跳 ${p.lastHeartbeat ? new Date(p.lastHeartbeat).toLocaleString() : '—'} · 模型 ${p.lastModel ?? '—'}`,
      ),
    ),
    el('div', { className: 'pause-wrap' + (p.paused ? ' paused' : '') }, pauseBtn),
  ));

  if (p.currentTask) {
    c.appendChild(el('div', { className: 'current-task' },
      el('div', { className: 'label' }, '正在执行'),
      el('div', { className: 'title' }, `#${p.currentTask.id} ${p.currentTask.desc}`),
      el('div', { className: 'tags' },
        el('span', { className: 'chip' }, p.currentTask.scope ?? '—'),
        el('span', { className: `chip prio-${p.currentTask.priority || '中'}` }, p.currentTask.priority ?? '—'),
      ),
    ));
  }

  c.appendChild(el('div', { className: 'kanban' },
    renderColumn('待办', 'todo', tasks.todo),
    renderColumn('进行中', 'in_progress', tasks.in_progress),
    renderColumn('待 review', 'review', tasks.review),
    renderColumn('阻塞', 'blocked', tasks.blocked),
  ));

  c.appendChild(renderDoneStrip(tasks.done_today));
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

async function cleanupMissing(count) {
  if (!confirm(`确认从注册表移除 ${count} 个失联项目？\n（不会删除任何磁盘文件，仅清理注册表条目）`)) return;
  const r = await postAction('/api/cleanup-missing');
  if (r.ok) {
    await refreshProjects();
  } else {
    alert(`清理失败: ${r.body?.error || r.status}`);
  }
}

refreshProjects();
setInterval(refreshProjects, 5000);
