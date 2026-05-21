'use strict';

const state = {
  projects: [],
  selectedSlug: null,
  detail: null,
  doneCollapsed: true,
  collapsedCards: new Set(),
  addModal: null,
  loopCmdModal: null,
};

const LONG_TEXT_THRESHOLD = 120;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'className') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === false || v == null) continue;
    else e.setAttribute(k, v === true ? '' : v);
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

function truncateLink(s) {
  if (!s) return '';
  return s.length <= 40 ? s : '…' + s.slice(-37);
}

async function openTaskLink(link) {
  if (!link) return;
  if (/^https?:\/\//i.test(link)) {
    window.open(link, '_blank', 'noopener');
    return;
  }
  const r = await postAction('/api/open', { target: link });
  if (!r.ok) {
    alert(`打开失败: ${r.body?.error || r.status}`);
  }
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

  const cardKey = `${state.selectedSlug}:${t.id}`;
  const collapsed = state.collapsedCards.has(cardKey);
  const extra = group === 'review' ? t.risk : group === 'blocked' ? t.question : '';
  const totalLen = (t.desc || '').length + (extra || '').length;
  const collapsible = totalLen > LONG_TEXT_THRESHOLD;

  const children = [
    el('div', { className: 'card-desc' },
      el('span', { className: 'card-id' }, `#${t.id}`),
      t.desc || '',
    ),
    el('div', { className: 'card-chips' }, ...chips),
  ];

  if (extra) {
    children.push(el('div', { className: 'card-extra' }, extra));
  }

  if (t.link) {
    children.push(el('div', { className: 'card-link' },
      el('button', {
        className: 'btn-link link-open',
        title: t.link,
        onclick: (e) => {
          e.stopPropagation();
          openTaskLink(t.link);
        },
      }, '↗ ' + truncateLink(t.link)),
    ));
  }

  if (collapsible) {
    children.push(el('div', { className: 'card-toggle' },
      el('button', {
        className: 'btn-link',
        onclick: (e) => {
          e.stopPropagation();
          if (collapsed) state.collapsedCards.delete(cardKey);
          else state.collapsedCards.add(cardKey);
          renderDetail();
        },
      }, collapsed ? '▾ 展开' : '▴ 收起'),
    ));
  }

  if (group === 'todo') {
    children.push(el('div', { className: 'card-actions' },
      el('button', { className: 'btn', onclick: () => changePriority(t.id) }, '改优先级'),
      el('button', { className: 'btn danger', onclick: () => skipTask(t.id) }, 'skip'),
    ));
  }

  return el('div', { className: 'card' + (collapsible && collapsed ? ' collapsed' : '') }, ...children);
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

  const addBtn = el('button', {
    className: 'btn',
    disabled: !(state.detail.scopes && state.detail.scopes.length > 0),
    onclick: () => openAddModal(),
    title: state.detail.scopes && state.detail.scopes.length > 0 ? '' : 'project.config.js 缺失或无 scope',
  }, '+ 新增任务');

  const loopBtn = el('button', {
    className: 'btn',
    onclick: () => openLoopCmdModal(),
    title: '生成并复制启动命令，粘贴到 terminal 即可跑起 loop',
  }, '📋 复制启动命令');

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
    el('div', { className: 'header-actions' }, addBtn, loopBtn, pauseBtn),
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

  renderAddModal();
  renderLoopCmdModal();
}

function renderAddModal() {
  const existing = document.getElementById('add-modal');
  if (existing) existing.remove();
  if (!state.addModal) return;

  const { scopes } = state.detail || { scopes: [] };
  const form = state.addModal;

  const descInput = el('textarea', {
    className: 'modal-input',
    rows: 3,
    placeholder: '任务描述（必填）',
  });
  descInput.value = form.desc || '';
  descInput.addEventListener('input', e => { form.desc = e.target.value; });

  const scopeSelect = el('select', { className: 'modal-input' },
    ...scopes.map(s => el('option', { value: s, selected: s === form.scope ? '' : null }, s)),
  );
  scopeSelect.addEventListener('change', e => { form.scope = e.target.value; });

  const prioSelect = el('select', { className: 'modal-input' },
    ...['高', '中', '低'].map(p => el('option', { value: p, selected: p === form.priority ? '' : null }, p)),
  );
  prioSelect.addEventListener('change', e => { form.priority = e.target.value; });

  const noteInput = el('input', {
    className: 'modal-input',
    type: 'text',
    placeholder: '备注（可选）',
  });
  noteInput.value = form.note || '';
  noteInput.addEventListener('input', e => { form.note = e.target.value; });

  const linkInput = el('input', {
    className: 'modal-input',
    type: 'text',
    placeholder: '链接 / 本地路径（可选，点击卡片打开）',
  });
  linkInput.value = form.link || '';
  linkInput.addEventListener('input', e => { form.link = e.target.value; });

  const errorBox = el('div', { className: 'modal-error', id: 'modal-error' });

  const modal = el('div', { id: 'add-modal', className: 'modal-backdrop', onclick: e => {
    if (e.target.id === 'add-modal') closeAddModal();
  } },
    el('div', { className: 'modal' },
      el('div', { className: 'modal-title' }, '新增任务'),
      el('label', { className: 'modal-label' }, '描述', descInput),
      el('div', { className: 'modal-row' },
        el('label', { className: 'modal-label' }, 'scope', scopeSelect),
        el('label', { className: 'modal-label' }, '优先级', prioSelect),
      ),
      el('label', { className: 'modal-label' }, '备注', noteInput),
      el('label', { className: 'modal-label' }, '链接', linkInput),
      errorBox,
      el('div', { className: 'modal-actions' },
        el('button', { className: 'btn', onclick: closeAddModal }, '取消'),
        el('button', { className: 'btn primary', onclick: submitAddRow }, '添加'),
      ),
    ),
  );
  document.body.appendChild(modal);
  descInput.focus();
}

function openAddModal() {
  const scopes = (state.detail && state.detail.scopes) || [];
  state.addModal = {
    desc: '',
    scope: scopes[0] || '',
    priority: '中',
    note: '',
    link: '',
  };
  renderAddModal();
}

function closeAddModal() {
  state.addModal = null;
  renderAddModal();
}

async function submitAddRow() {
  const form = state.addModal;
  if (!form) return;
  if (!form.desc.trim()) {
    document.getElementById('modal-error').textContent = '描述不能为空';
    return;
  }
  if (!form.scope) {
    document.getElementById('modal-error').textContent = '请选择 scope';
    return;
  }
  const r = await postAction(`/api/projects/${state.selectedSlug}/add-row`, {
    desc: form.desc.trim(),
    scope: form.scope,
    priority: form.priority,
    note: form.note.trim(),
    link: form.link.trim(),
  });
  if (r.ok) {
    closeAddModal();
    await refreshProjects();
  } else {
    document.getElementById('modal-error').textContent = r.body?.error || `失败 (${r.status})`;
  }
}

async function openLoopCmdModal() {
  state.loopCmdModal = { loading: true, command: '', error: '', copied: false };
  renderLoopCmdModal();
  try {
    const r = await fetch(`/api/projects/${state.selectedSlug}/loop-command`);
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      state.loopCmdModal = { loading: false, command: body.command || '', error: '', copied: false };
    } else {
      state.loopCmdModal = { loading: false, command: '', error: body.error || `失败 (${r.status})`, copied: false };
    }
  } catch (err) {
    state.loopCmdModal = { loading: false, command: '', error: String(err.message), copied: false };
  }
  renderLoopCmdModal();
}

function closeLoopCmdModal() {
  state.loopCmdModal = null;
  renderLoopCmdModal();
}

async function copyLoopCommand() {
  const m = state.loopCmdModal;
  if (!m || !m.command) return;
  try {
    await navigator.clipboard.writeText(m.command);
    m.copied = true;
    renderLoopCmdModal();
  } catch (err) {
    m.error = '复制失败：' + err.message;
    renderLoopCmdModal();
  }
}

function renderLoopCmdModal() {
  const existing = document.getElementById('loop-cmd-modal');
  if (existing) existing.remove();
  if (!state.loopCmdModal) return;

  const m = state.loopCmdModal;
  const cmdArea = el('textarea', {
    className: 'modal-input loop-cmd-area',
    readonly: '',
    rows: 8,
    placeholder: m.loading ? '生成中…' : '',
  });
  cmdArea.value = m.command || '';
  cmdArea.addEventListener('focus', () => cmdArea.select());

  const hint = el('div', { className: 'modal-error' },
    m.error ? m.error : m.copied ? '✓ 已复制，去 terminal 粘贴即可启动' : '在项目目录下粘贴这条命令即可启动 loop',
  );

  const modal = el('div', {
    id: 'loop-cmd-modal',
    className: 'modal-backdrop',
    onclick: e => { if (e.target.id === 'loop-cmd-modal') closeLoopCmdModal(); },
  },
    el('div', { className: 'modal' },
      el('div', { className: 'modal-title' }, 'loop 启动命令'),
      el('label', { className: 'modal-label' }, '完整命令（已替换 PROJECT_ROOT）', cmdArea),
      hint,
      el('div', { className: 'modal-actions' },
        el('button', { className: 'btn', onclick: closeLoopCmdModal }, '关闭'),
        el('button', {
          className: 'btn primary',
          disabled: m.loading || !m.command,
          onclick: copyLoopCommand,
        }, m.copied ? '✓ 已复制' : '复制'),
      ),
    ),
  );
  document.body.appendChild(modal);
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
