'use strict';

const state = {
  projects: [],
  selectedSlug: null,
  detail: null,
  doneCollapsed: true,
  kanbanCollapsed: false,
  collapsedCards: new Set(),
  addModal: null,
  loopCmdModal: null,
  replyModal: null,
  imagePreview: null,
  cardDetailModal: null,
};

const LONG_TEXT_THRESHOLD = 120;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const THEME_KEY = 'task-queue-theme';
const VALID_THEMES = ['dark', 'eye-care'];

function applyTheme(theme) {
  const t = VALID_THEMES.includes(theme) ? theme : 'dark';
  if (t === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = t === 'eye-care' ? '☀️' : '🌙';
    btn.title = t === 'eye-care' ? '切到深色' : '切到护眼浅色';
  }
}

function toggleTheme() {
  const cur = localStorage.getItem(THEME_KEY) || 'dark';
  const next = cur === 'eye-care' ? 'dark' : 'eye-care';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

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

async function openTarget(target, projectRoot) {
  if (!target) return;
  if (/^https?:\/\//i.test(target)) {
    window.open(target, '_blank', 'noopener');
    return;
  }
  const r = await postAction('/api/open', { target, projectRoot });
  if (!r.ok) {
    alert(`打开失败: ${r.body?.error || r.status}`);
  }
}

/**
 * 把 Claude 生成的字段文本（desc/note/risk/question）切成 [string, <a>] 数组，
 * 自动识别 URL/绝对路径/相对路径/file:line，点击调 openTarget。
 * 在 el(...children) 里展开使用。
 * @param {string} text
 * @returns {Array<string|HTMLElement>}
 */
/** 判断一个路径(可能带 :line:col)是否是支持的图片 */
function isImageAttachment(s) {
  return /\.(png|jpe?g|gif|webp)$/i.test(String(s).replace(/:\d+(?::\d+)?$/, ''));
}

/** 从任意字段文本里抽出 `.tasks/attachments/*.png|jpg|gif|webp` 路径列表(去重保序) */
function extractAttachmentPaths(text) {
  if (!text) return [];
  const re = /\.tasks\/attachments\/[^\s)<>"'`,]+\.(?:png|jpe?g|gif|webp)/gi;
  const found = String(text).match(re) || [];
  return [...new Set(found)];
}

/** 在卡片底部渲染一排小缩略图(用于 todo/in_progress/review/blocked,done 已通过 linkifyText 内联) */
function renderCardAttachStrip(paths) {
  if (!paths.length) return null;
  const slug = state.selectedSlug;
  const projectRoot = state.detail?.project?.root;
  return el('div', { className: 'card-attach-strip' },
    ...paths.map(p => {
      const src = `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(p)}`;
      return el('a', {
        className: 'attach-inline-link',
        href: '#',
        title: `${p}（点击查看大图）`,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openImagePreview(src, p, projectRoot);
        },
      }, el('img', { src, className: 'attach-thumb-card', alt: p }));
    }),
  );
}

/**
 * 打开图片大图预览;点击背景或按 ESC 关闭,modal 内有"在编辑器中打开"按钮可继续走 openTarget。
 */
function openImagePreview(src, path, projectRoot) {
  state.imagePreview = { src, path, projectRoot };
  renderImagePreview();
}

function closeImagePreview() {
  state.imagePreview = null;
  const ex = document.getElementById('image-preview-modal');
  if (ex) ex.remove();
  document.removeEventListener('keydown', handleImagePreviewKey);
}

function handleImagePreviewKey(e) {
  if (e.key === 'Escape') closeImagePreview();
}

function renderImagePreview() {
  const existing = document.getElementById('image-preview-modal');
  if (existing) existing.remove();
  if (!state.imagePreview) return;
  const { src, path, projectRoot } = state.imagePreview;

  const modal = el('div', {
    id: 'image-preview-modal',
    className: 'modal-backdrop image-preview-backdrop',
    onclick: e => { if (e.target.id === 'image-preview-modal') closeImagePreview(); },
  },
    el('div', { className: 'image-preview-box' },
      el('div', { className: 'image-preview-toolbar' },
        el('span', { className: 'image-preview-path', title: path }, path),
        el('button', {
          className: 'btn',
          title: '在系统/编辑器中打开原图',
          onclick: (e) => {
            e.stopPropagation();
            openTarget(path, projectRoot);
          },
        }, '🔗 在编辑器打开'),
        el('button', {
          className: 'btn',
          onclick: closeImagePreview,
        }, '关闭 (ESC)'),
      ),
      el('div', { className: 'image-preview-canvas' },
        el('img', {
          src,
          className: 'image-preview-img',
          alt: path,
          onclick: (e) => e.stopPropagation(),
        }),
      ),
    ),
  );
  document.body.appendChild(modal);
  document.addEventListener('keydown', handleImagePreviewKey);
}

/**
 * 任务卡片放大详情 modal:点击卡片空白区打开,展示完整 desc/note/risk/question/附件大图入口。
 * 点背景或 ESC 关闭。modal 内的图片缩略图仍可点击进入 image-preview lightbox。
 */
function openCardDetailModal(task, group) {
  state.cardDetailModal = { task, group };
  renderCardDetailModal();
}

function closeCardDetailModal() {
  state.cardDetailModal = null;
  const ex = document.getElementById('card-detail-modal');
  if (ex) ex.remove();
  document.removeEventListener('keydown', handleCardDetailKey);
}

function handleCardDetailKey(e) {
  if (e.key === 'Escape') closeCardDetailModal();
}

function formatTime(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); }
  catch { return String(s); }
}

const GROUP_LABEL = {
  todo: '待办',
  in_progress: '进行中',
  review: '待 review',
  blocked: '阻塞',
  done: '已完成',
};

function renderCardDetailModal() {
  const ex = document.getElementById('card-detail-modal');
  if (ex) ex.remove();
  if (!state.cardDetailModal) return;
  const { task: t, group } = state.cardDetailModal;

  const sections = [];

  // 元信息行
  sections.push(el('div', { className: 'detail-meta-row' },
    el('span', { className: 'chip' }, t.scope || '—'),
    el('span', { className: `chip prio-${t.priority || '中'}` }, t.priority || '中'),
    el('span', { className: 'chip status-chip' }, GROUP_LABEL[group] || group || '—'),
    el('span', { className: 'detail-meta-time' },
      `创建 ${formatTime(t.ctime)}${t.ftime ? ` · 完成 ${formatTime(t.ftime)}` : ''}`,
    ),
  ));

  // 描述
  sections.push(el('div', { className: 'detail-section' },
    el('div', { className: 'detail-section-title' }, '描述'),
    el('div', { className: 'detail-section-body' }, ...linkifyText(t.desc || '—')),
  ));

  // risk / question
  if (t.risk) {
    sections.push(el('div', { className: 'detail-section detail-section-risk' },
      el('div', { className: 'detail-section-title' }, '⚠ 风险'),
      el('div', { className: 'detail-section-body' }, ...linkifyText(t.risk)),
    ));
  }
  if (t.question) {
    sections.push(el('div', { className: 'detail-section detail-section-question' },
      el('div', { className: 'detail-section-title' }, '? 疑问'),
      el('div', { className: 'detail-section-body' }, ...linkifyText(t.question)),
    ));
  }

  // note 历史 / 完成块
  if (t.note && String(t.note).trim()) {
    sections.push(el('div', { className: 'detail-section' },
      el('div', { className: 'detail-section-title' }, 'Note / 历史'),
      el('div', { className: 'detail-section-body note-pre' }, ...linkifyText(t.note)),
    ));
  }

  // 附件大图(只取图片,desc+note 合集)
  const attachPaths = [
    ...extractAttachmentPaths(t.desc || ''),
    ...extractAttachmentPaths(t.note || ''),
  ];
  const uniq = [...new Set(attachPaths)];
  if (uniq.length) {
    sections.push(el('div', { className: 'detail-section' },
      el('div', { className: 'detail-section-title' }, `附件 (${uniq.length})`),
      el('div', { className: 'detail-attach-grid' },
        ...uniq.map(p => {
          const slug = state.selectedSlug;
          const projectRoot = state.detail?.project?.root;
          const src = `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(p)}`;
          return el('a', {
            className: 'attach-inline-link',
            href: '#',
            title: `${p}（点击查看大图）`,
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              openImagePreview(src, p, projectRoot);
            },
          }, el('img', { src, className: 'detail-attach-thumb', alt: p }));
        }),
      ),
    ));
  }

  // 动作行(根据 group 提供回复入口)
  const actions = [];
  if (group === 'review' || group === 'blocked') {
    actions.push(el('button', {
      className: 'btn primary',
      onclick: () => {
        closeCardDetailModal();
        openReplyModal(t, group);
      },
    }, '💬 回复'));
  }
  actions.push(el('button', { className: 'btn', onclick: closeCardDetailModal }, '关闭 (ESC)'));

  const modal = el('div', {
    id: 'card-detail-modal',
    className: 'modal-backdrop card-detail-backdrop',
    onclick: (e) => { if (e.target.id === 'card-detail-modal') closeCardDetailModal(); },
  },
    el('div', { className: 'modal card-detail-modal' },
      el('div', { className: 'card-detail-header' },
        el('div', { className: 'card-detail-title' }, `#${t.id} ${t.desc || ''}`),
      ),
      el('div', { className: 'card-detail-body' }, ...sections),
      el('div', { className: 'modal-actions' }, ...actions),
    ),
  );
  document.body.appendChild(modal);
  document.addEventListener('keydown', handleCardDetailKey);
}

function linkifyText(text) {
  if (!text) return [''];
  if (typeof Linkify === 'undefined' || !Linkify) return [text];
  const projectRoot = state.detail?.project?.root;
  const slug = state.selectedSlug;
  return Linkify.linkify(text, (m) => {
    // 图片附件 → 渲染 inline <img>(点击打开大图预览,预览内仍可"在编辑器打开")
    if (m.kind === 'file' && isImageAttachment(m.text) && slug) {
      const pure = m.text.replace(/:\d+(?::\d+)?$/, '');
      // 仅 .tasks/attachments/ 下相对路径走静态文件路由（路径校验在后端二次把关）
      const isLocalAttach = pure.startsWith('.tasks/attachments/');
      if (isLocalAttach) {
        const src = `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(pure)}`;
        return el('a', {
          className: 'attach-inline-link',
          href: '#',
          title: `${m.text}（点击查看大图）`,
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            openImagePreview(src, m.text, projectRoot);
          },
        }, el('img', { src, className: 'attach-inline', alt: m.text }));
      }
    }
    return el('a', {
      className: 'linkified',
      href: '#',
      title: m.kind === 'url' ? m.text : (projectRoot ? '点击用编辑器打开' : '点击尝试打开'),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTarget(m.text, projectRoot);
      },
    }, m.text);
  });
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
  for (const tag of parseTagString(t.tags)) {
    chips.push(el('span', { className: 'chip tag-chip', title: '标签' }, tag));
  }
  if (t.model) {
    chips.push(el('span', { className: 'chip model-chip', title: `模型覆盖: ${t.model}` }, `🤖 ${t.model}`));
  }
  if (t.risk) chips.push(el('span', { className: 'chip risk', title: t.risk }, '⚠ 风险'));
  if (t.question) chips.push(el('span', { className: 'chip question', title: t.question }, '? 疑问'));

  const cardKey = `${state.selectedSlug}:${t.id}`;
  const collapsed = state.collapsedCards.has(cardKey);
  // review 看风险,blocked 看疑问,done 看 note(commit hash / 模块 / 文件等审查信息)
  const extra = group === 'review' ? t.risk
    : group === 'blocked' ? t.question
    : group === 'done' ? t.note
    : '';
  const totalLen = (t.desc || '').length + (extra || '').length;
  const collapsible = totalLen > LONG_TEXT_THRESHOLD;

  const children = [
    el('div', { className: 'card-desc' },
      el('span', { className: 'card-id' }, `#${t.id}`),
      ...linkifyText(t.desc || ''),
    ),
    el('div', { className: 'card-chips' }, ...chips),
  ];

  if (extra) {
    children.push(el('div', { className: 'card-extra' }, ...linkifyText(extra)));
  }

  // todo/in_progress/review/blocked 卡片不渲染 note 全文,但用户贴的附件应当一直可见;
  // 从 desc + note 抽路径,渲染一排小缩略图。done 状态下 note 整段已被 linkifyText 内联,跳过避免重复。
  if (group !== 'done') {
    const attachPaths = [
      ...extractAttachmentPaths(t.desc || ''),
      ...extractAttachmentPaths(t.note || ''),
    ];
    const uniq = [...new Set(attachPaths)];
    const strip = renderCardAttachStrip(uniq);
    if (strip) children.push(strip);
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

  if (group === 'todo' || group === 'blocked' || group === 'review') {
    const projectModel = state.detail?.project?.desiredModel || 'opus';
    const taskModelSel = el('select',
      {
        className: 'task-model-select',
        title: `任务级模型覆盖（空=跟随项目级 ${projectModel}）`,
        onchange: (e) => changeTaskModel(t.id, e.target.value),
        onclick: (e) => e.stopPropagation(),
      },
      el('option', { value: '' }, `跟随项目 (${projectModel})`),
      el('option', { value: 'opus' }, 'Opus'),
      el('option', { value: 'sonnet' }, 'Sonnet'),
      el('option', { value: 'haiku' }, 'Haiku'),
    );
    taskModelSel.value = t.model || '';

    if (group === 'todo') {
      const prioritySel = el('select',
        {
          className: 'priority-select',
          title: '改优先级',
          onchange: (e) => changePriority(t.id, e.target.value),
          onclick: (e) => e.stopPropagation(),
        },
        el('option', { value: '高' }, '高'),
        el('option', { value: '中' }, '中'),
        el('option', { value: '低' }, '低'),
      );
      prioritySel.value = t.priority || '中';
      children.push(el('div', { className: 'card-actions' },
        prioritySel,
        taskModelSel,
        el('button', { className: 'btn danger', onclick: () => skipTask(t.id) }, 'skip'),
      ));
    } else {
      children.push(el('div', { className: 'card-actions' },
        taskModelSel,
        el('button', {
          className: 'btn primary',
          onclick: () => openReplyModal(t, group),
        }, '💬 回复'),
      ));
    }
  }

  return el('div', {
    className: 'card card-clickable' + (collapsible && collapsed ? ' collapsed' : ''),
    onclick: (e) => {
      // 跳过点到内部交互元素(按钮、链接、缩略图)的情况,只处理"点了卡片空白区"
      if (e.target.closest('button, a, select, .btn-link, .attach-inline-link, .card-attach-strip')) return;
      openCardDetailModal(t, group);
    },
  }, ...children);
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

function renderKanbanSection(tasks) {
  const collapsed = state.kanbanCollapsed;
  const counts = [
    ['待办', tasks.todo.length],
    ['进行中', tasks.in_progress.length],
    ['待 review', tasks.review.length],
    ['阻塞', tasks.blocked.length],
  ];
  const summary = counts.map(([k, v]) => `${k} ${v}`).join(' · ');
  return el('div', { className: 'kanban-section' + (collapsed ? ' collapsed' : '') },
    el('div', {
      className: 'kanban-header',
      onclick: () => { state.kanbanCollapsed = !state.kanbanCollapsed; renderDetail(); },
    },
      el('span', null, summary),
      el('span', null, collapsed ? '▸ 展开看板' : '▾ 折叠看板'),
    ),
    el('div', { className: 'kanban' },
      renderColumn('待办', 'todo', tasks.todo),
      renderColumn('进行中', 'in_progress', tasks.in_progress),
      renderColumn('待 review', 'review', tasks.review),
      renderColumn('阻塞', 'blocked', tasks.blocked),
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
      ...items.map(t => renderCard(t, 'done')),
    ),
  );
}

function renderDetail() {
  $('#detail-empty').style.display = state.detail ? 'none' : 'block';
  const c = $('#detail-content');
  c.style.display = state.detail ? 'flex' : 'none';
  if (!state.detail) return;

  const { project: p, tasks } = state.detail;

  // 在 c.innerHTML='' 之前快照所有需要保留滚动位置的容器,渲染完再写回 —— 否则 5s 轮询
  // 每次重建 DOM 都把 done-body / column .col-body 的 scrollTop 重置成 0,用户滚到一半就
  // 被甩回顶部。selector → scrollTop 的 map,key 只取第一个匹配(目前每种容器都只有一个)。
  const scrollSelectors = ['.done-body', '.kanban-section .column .col-body'];
  const savedScroll = {};
  for (const sel of scrollSelectors) {
    const node = c.querySelector(sel);
    if (node) savedScroll[sel] = node.scrollTop;
  }

  c.innerHTML = '';

  const pauseBtn = el('button', {
    className: 'btn' + (p.paused ? '' : ' primary'),
    onclick: () => p.paused ? resumeProject() : pauseProject(),
  }, p.paused ? `▶ 恢复轮询${p.pauseReason ? `(${p.pauseReason})` : ''}` : '⏸ 暂停轮询');

  const wakeDisabled = p.paused || p.online === 'offline' || p.online === 'missing' || p.wakeNow;
  const wakeBtn = el('button', {
    className: 'btn',
    disabled: wakeDisabled,
    title: p.paused ? '已暂停轮询，先恢复再点立即执行'
      : (p.online === 'offline' || p.online === 'missing') ? 'loop 未运行'
      : p.wakeNow ? '已发出立即执行请求，等 loop 响应'
      : '让 loop 在下次唤醒时（≤ idleSleepSeconds）立刻扫一次任务',
    onclick: () => wakeNowProject(),
  }, p.wakeNow ? '⏳ 唤醒中…' : '⚡ 立即执行');

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

  const desired = p.desiredModel || 'opus';
  const modelSel = el('select', {
    className: 'model-select',
    title: '执行模型（subagent 派发用，任务级覆盖优先于此项）',
    onchange: (e) => changeDesiredModel(e.target.value),
  },
    el('option', { value: 'opus' }, 'Opus'),
    el('option', { value: 'sonnet' }, 'Sonnet'),
    el('option', { value: 'haiku' }, 'Haiku'),
  );
  modelSel.value = desired;
  const modelGroup = el('label', { className: 'model-group', title: '主 loop 始终 opus；这里切的是 subagent 跑任务时用的模型' },
    el('span', { className: 'model-group-label' }, '执行模型'),
    modelSel,
  );

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
    el('div', { className: 'header-actions' }, modelGroup, addBtn, wakeBtn, pauseBtn, loopBtn),
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

  c.appendChild(renderKanbanSection(tasks));

  c.appendChild(renderDoneStrip(tasks.done_today));

  for (const [sel, top] of Object.entries(savedScroll)) {
    const node = c.querySelector(sel);
    if (node) node.scrollTop = top;
  }

  // 这三个 modal 由 state 驱动(open/close/paste 时显式调 render),
  // 不在 renderDetail 里调用,以免每 5s 轮询触发 modal DOM 重建 ——
  // 重建会清掉 paste 上传的缩略图、抢焦点、丢失文本框选区。
  // renderDetail 重渲染时,如果 modal 已在显示,保持原样不动。
}

/**
 * 绑定 IME 安全的 input 监听:中文输入法 composition 期间不触发回调,
 * 避免拼音中途回写打断 IME(macOS Safari/Chrome 上常见症状是"q 直接落进框")。
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 * @param {(value: string) => void} onValue
 */
function bindImeSafeInput(input, onValue) {
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', e => {
    composing = false;
    onValue(e.target.value);
  });
  input.addEventListener('input', e => {
    if (composing || e.isComposing) return;
    onValue(e.target.value);
  });
}

/**
 * 把 row.tags（管道分隔字符串）拆成数组；其他形态宽容处理。
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseTagString(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(raw).split('|').map(s => s.trim()).filter(Boolean);
}

/**
 * 扫描当前 state.detail 中所有任务的 tags 字段，按使用频次降序返回去重 tag 列表。
 * 用于新增任务 modal 的自动补全候选。
 * @param {object|null} detail
 * @returns {string[]}
 */
function collectKnownTags(detail) {
  if (!detail || !detail.tasks) return [];
  const freq = new Map();
  for (const group of ['in_progress', 'todo', 'review', 'blocked', 'done_today']) {
    const arr = detail.tasks[group] || [];
    for (const t of arr) {
      for (const tag of parseTagString(t.tags)) {
        freq.set(tag, (freq.get(tag) || 0) + 1);
      }
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

/**
 * 构造一个 chip-input 控件。控件内部维护一个 chips 数组 + 一个文本输入,
 * 通过逗号/回车提交新 chip,backspace 在空输入下删最后一个 chip,
 * 输入时弹自动补全下拉(从 knownTags 里过滤 prefix)。
 *
 * 控件直接 mutate `form.tags`(string[]),调用方无需额外 wire-up。
 *
 * @param {{ tags: string[] }} form 调用方的 form state(引用透传,会被 mutate)
 * @param {string[]} knownTags 候选 tag 集合
 * @returns {HTMLElement}
 */
function buildTagInput(form, knownTags) {
  form.tags = Array.isArray(form.tags) ? form.tags : [];

  const wrap = el('div', { className: 'chip-input' });
  const chipsBox = el('div', { className: 'chip-input-chips' });
  const input = el('input', {
    className: 'chip-input-field',
    type: 'text',
    placeholder: '回车 / 逗号添加；点击下拉补全',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const suggestBox = el('div', { className: 'chip-input-suggest' });

  function renderChips() {
    chipsBox.innerHTML = '';
    for (const t of form.tags) {
      const chip = el('span', { className: 'chip tag-chip' }, t);
      const x = el('button', {
        className: 'chip-remove',
        type: 'button',
        title: '移除',
        onclick: () => {
          form.tags = form.tags.filter(x => x !== t);
          renderChips();
        },
      }, '×');
      chip.appendChild(x);
      chipsBox.appendChild(chip);
    }
    chipsBox.appendChild(input);
  }

  function addTag(raw) {
    const t = String(raw || '').trim();
    if (!t) return false;
    if (form.tags.includes(t)) return false;
    form.tags.push(t);
    renderChips();
    return true;
  }

  function renderSuggest() {
    suggestBox.innerHTML = '';
    const q = input.value.trim().toLowerCase();
    if (!q) { suggestBox.style.display = 'none'; return; }
    const matches = knownTags
      .filter(t => !form.tags.includes(t) && t.toLowerCase().includes(q))
      .slice(0, 8);
    if (matches.length === 0) { suggestBox.style.display = 'none'; return; }
    for (const m of matches) {
      const item = el('div', {
        className: 'chip-input-suggest-item',
        onmousedown: e => {
          // mousedown 而非 click,避免 input 先 blur 导致下拉被 unmount。
          e.preventDefault();
          addTag(m);
          input.value = '';
          renderSuggest();
          input.focus();
        },
      }, m);
      suggestBox.appendChild(item);
    }
    suggestBox.style.display = 'block';
  }

  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; renderSuggest(); });
  input.addEventListener('input', () => {
    if (composing) return;
    // 用户输入逗号 → 自动断词,把逗号前的所有段都 commit。
    if (input.value.includes(',') || input.value.includes('，')) {
      const parts = input.value.split(/[,，]/);
      const tail = parts.pop();
      for (const p of parts) addTag(p);
      input.value = tail;
    }
    renderSuggest();
  });
  input.addEventListener('keydown', e => {
    if (composing || e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.value.trim()) {
        addTag(input.value);
        input.value = '';
        renderSuggest();
      }
    } else if (e.key === 'Backspace' && input.value === '' && form.tags.length > 0) {
      form.tags = form.tags.slice(0, -1);
      renderChips();
    }
  });
  input.addEventListener('blur', () => {
    // blur 时把残留输入也 commit,避免用户点"添加"前忘了回车。
    setTimeout(() => {
      if (input.value.trim()) {
        addTag(input.value);
        input.value = '';
      }
      suggestBox.style.display = 'none';
    }, 120);
  });

  renderChips();
  wrap.appendChild(chipsBox);
  wrap.appendChild(suggestBox);
  suggestBox.style.display = 'none';
  return wrap;
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
    placeholder: '任务描述（必填,可粘贴图片自动上传）',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  descInput.value = form.desc || '';
  bindImeSafeInput(descInput, v => { form.desc = v; });

  const scopeSelect = el('select', { className: 'modal-input' },
    ...scopes.map(s => el('option', { value: s, selected: s === form.scope ? '' : null }, s)),
  );
  scopeSelect.addEventListener('change', e => { form.scope = e.target.value; });

  const prioSelect = el('select', { className: 'modal-input' },
    ...['高', '中', '低'].map(p => el('option', { value: p, selected: p === form.priority ? '' : null }, p)),
  );
  prioSelect.addEventListener('change', e => { form.priority = e.target.value; });

  // 模型选项: 空串 = 跟项目(由 desiredModel 决定),否则覆盖
  const MODEL_OPTIONS = [
    { value: '',       label: '跟项目' },
    { value: 'opus',   label: 'opus' },
    { value: 'sonnet', label: 'sonnet' },
    { value: 'haiku',  label: 'haiku' },
  ];
  const modelSelect = el('select', { className: 'modal-input' },
    ...MODEL_OPTIONS.map(o => el(
      'option',
      { value: o.value, selected: o.value === (form.model || '') ? '' : null },
      o.label,
    )),
  );
  modelSelect.addEventListener('change', e => { form.model = e.target.value; });

  const tagInput = buildTagInput(form, collectKnownTags(state.detail));

  const noteInput = el('input', {
    className: 'modal-input',
    type: 'text',
    placeholder: '备注（可选）',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  noteInput.value = form.note || '';
  bindImeSafeInput(noteInput, v => { form.note = v; });

  const attachContainer = el('div', { className: 'attach-list', id: 'modal-attach-list' });
  // 根据 state 里持久化的 attachments 重建缩略图(轮询可能在打字时重渲染 modal,
  // 但因为 form 是 state.addModal 的引用,数据不丢)
  for (const a of (form.attachments || [])) {
    attachContainer.appendChild(el('div', { className: 'attach-item', title: a.path },
      el('img', { src: a.dataUrl, className: 'attach-thumb' }),
      el('span', { className: 'attach-path' }, a.path),
    ));
  }

  const errorBox = el('div', { className: 'modal-error', id: 'modal-error' });

  descInput.addEventListener('paste', e => handleModalPaste(e, form, noteInput, attachContainer, errorBox));

  const modal = el('div', { id: 'add-modal', className: 'modal-backdrop', onclick: e => {
    if (e.target.id === 'add-modal') closeAddModal();
  } },
    el('div', { className: 'modal' },
      el('div', { className: 'modal-title' }, '新增任务'),
      el('label', { className: 'modal-label' }, '描述', descInput),
      el('div', { className: 'modal-row' },
        el('label', { className: 'modal-label' }, 'scope', scopeSelect),
        el('label', { className: 'modal-label' }, '优先级', prioSelect),
        el('label', { className: 'modal-label' }, '模型', modelSelect),
      ),
      el('label', { className: 'modal-label' }, '标签', tagInput),
      el('label', { className: 'modal-label' }, '备注', noteInput),
      attachContainer,
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
    tags: [],
    model: '',
    attachments: [],
  };
  renderAddModal();
}

function closeAddModal() {
  state.addModal = null;
  renderAddModal();
}

/** 支持上传的图片 MIME（与后端 ALLOWED_IMAGE_TYPES 保持一致） */
const ALLOWED_PASTE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_PASTE_BYTES = 5 * 1024 * 1024;

/**
 * 把 Blob 转成 base64 字符串（不含 data:xxx;base64, 前缀）。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 在 errorBox 显示一条带颜色的状态消息（成功/错误/中性）。
 * @param {HTMLElement} box
 * @param {string} text
 * @param {'info'|'ok'|'err'} kind
 */
function showModalStatus(box, text, kind) {
  if (!box) return;
  box.textContent = text;
  box.classList.remove('upload-info', 'upload-ok', 'upload-err');
  box.classList.add(`upload-${kind}`);
}

/**
 * 处理新建任务 modal 中 desc textarea 的 paste 事件:
 * - 剪贴板含图片 → 拦截默认 paste,上传到 .tasks/attachments/,
 *   返回路径追加到 form.note,并在 attachContainer 显示缩略图
 * - 仅文本 → 不拦截,走默认 paste
 *
 * @param {ClipboardEvent} e
 * @param {object} form state.addModal 引用,变更直接落回
 * @param {HTMLInputElement} noteInput 备注输入框 DOM,需同步 .value
 * @param {HTMLElement} attachContainer 缩略图容器
 * @param {HTMLElement} statusBox modal 底部错误/状态盒子
 */
async function handleModalPaste(e, form, noteInput, attachContainer, statusBox) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let imgItem = null;
  for (const it of items) {
    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
      imgItem = it;
      break;
    }
  }
  if (!imgItem) return;

  e.preventDefault();
  const blob = imgItem.getAsFile();
  if (!blob) return;

  const type = (blob.type || '').toLowerCase();
  if (!ALLOWED_PASTE_TYPES.includes(type)) {
    showModalStatus(statusBox, `不支持的图片类型: ${type || '(空)'}`, 'err');
    return;
  }
  if (blob.size > MAX_PASTE_BYTES) {
    showModalStatus(statusBox, `图片过大（${(blob.size / 1024 / 1024).toFixed(1)}MB,上限 5MB）`, 'err');
    return;
  }

  showModalStatus(statusBox, '正在上传图片…', 'info');

  let dataBase64;
  try {
    dataBase64 = await blobToBase64(blob);
  } catch (err) {
    showModalStatus(statusBox, `读取图片失败: ${err.message}`, 'err');
    return;
  }

  const r = await postAction(`/api/projects/${state.selectedSlug}/upload-image`, {
    contentType: type,
    dataBase64,
  });

  if (!r.ok) {
    showModalStatus(statusBox, (r.body && r.body.error) || `上传失败 (${r.status})`, 'err');
    return;
  }

  const newPath = r.body && r.body.path;
  if (!newPath) {
    showModalStatus(statusBox, '上传成功但未返回路径', 'err');
    return;
  }

  const sep = form.note && form.note.length > 0 ? '\n' : '';
  form.note = (form.note || '') + sep + newPath;
  noteInput.value = form.note;

  // 持久化到 state(attachContainer 仅是当前 DOM 引用,会被 renderAddModal 重建覆盖);
  // 改成由 state 驱动,后续重渲染会从 form.attachments 重建缩略图。
  const dataUrl = URL.createObjectURL(blob);
  form.attachments = form.attachments || [];
  form.attachments.push({ path: newPath, dataUrl });

  attachContainer.appendChild(el('div', { className: 'attach-item', title: newPath },
    el('img', { src: dataUrl, className: 'attach-thumb' }),
    el('span', { className: 'attach-path' }, newPath),
  ));

  showModalStatus(statusBox, `已附加: ${newPath}`, 'ok');
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
    tags: Array.isArray(form.tags) ? form.tags : [],
    model: form.model || '',
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

function openReplyModal(task, group) {
  state.replyModal = {
    id: task.id,
    group,
    desc: task.desc || '',
    extra: group === 'review' ? (task.risk || '') : (task.question || ''),
    note: task.note || '',
    reply: '',
    resume: true,
    error: '',
    submitting: false,
  };
  renderReplyModal();
}

function closeReplyModal() {
  state.replyModal = null;
  renderReplyModal();
}

async function submitReply() {
  const m = state.replyModal;
  if (!m || m.submitting) return;
  if (!m.reply.trim()) {
    m.error = '回复内容不能为空';
    renderReplyModal();
    return;
  }
  m.submitting = true;
  m.error = '';
  renderReplyModal();

  const r = await postAction(`/api/projects/${state.selectedSlug}/reply`, {
    id: m.id,
    reply: m.reply.trim(),
    resume: !!m.resume,
  });
  if (r.ok) {
    closeReplyModal();
    await refreshProjects();
  } else {
    m.submitting = false;
    m.error = r.body?.error || `失败 (${r.status})`;
    renderReplyModal();
  }
}

async function submitReplyAndCopyLoop() {
  const m = state.replyModal;
  if (!m || m.submitting) return;
  if (!m.reply.trim()) {
    m.error = '回复内容不能为空';
    renderReplyModal();
    return;
  }
  m.submitting = true;
  m.error = '';
  renderReplyModal();

  const r = await postAction(`/api/projects/${state.selectedSlug}/reply`, {
    id: m.id,
    reply: m.reply.trim(),
    resume: true,
  });
  if (!r.ok) {
    m.submitting = false;
    m.error = r.body?.error || `落库失败 (${r.status})`;
    renderReplyModal();
    return;
  }

  try {
    const resp = await fetch(`/api/projects/${state.selectedSlug}/loop-command`);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.command) {
      m.submitting = false;
      m.error = '已落库，但获取命令失败：' + (body.error || resp.status);
      renderReplyModal();
      await refreshProjects();
      return;
    }
    await navigator.clipboard.writeText(body.command);
  } catch (err) {
    m.submitting = false;
    m.error = '已落库，但复制失败：' + err.message;
    renderReplyModal();
    await refreshProjects();
    return;
  }

  closeReplyModal();
  await refreshProjects();
  alert('✓ 回复已落库（状态转回待办），loop 启动命令已复制到剪贴板，去 terminal 粘贴即可让 claude 接手');
}

function renderReplyModal() {
  const existing = document.getElementById('reply-modal');
  if (existing) existing.remove();
  if (!state.replyModal) return;

  const m = state.replyModal;

  const replyInput = el('textarea', {
    className: 'modal-input',
    rows: 5,
    placeholder: '回复内容（会以 [reply 时间] 形式追加到任务 note 顶部）',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  replyInput.value = m.reply || '';
  bindImeSafeInput(replyInput, v => { m.reply = v; });

  const resumeCheckbox = el('input', { type: 'checkbox', id: 'reply-resume' });
  if (m.resume) resumeCheckbox.checked = true;
  resumeCheckbox.addEventListener('change', e => { m.resume = e.target.checked; });

  const resumeLabel = group => group === 'review'
    ? '提交后恢复为待办（取消 review 标记，让 loop 重做）'
    : '提交后恢复为待办（清空疑问，让 loop 重跑）';

  const extraBlock = m.extra ? el('div', { className: 'reply-extra' },
    el('div', { className: 'reply-extra-label' }, m.group === 'review' ? '风险' : '疑问'),
    el('div', { className: 'reply-extra-body' }, ...linkifyText(m.extra)),
  ) : null;

  const noteBlock = m.note ? el('details', { className: 'reply-note-details' },
    el('summary', null, '查看现有 note'),
    el('pre', { className: 'reply-note-pre' }, ...linkifyText(m.note)),
  ) : null;

  const errorBox = el('div', { className: 'modal-error' }, m.error || '');

  const modal = el('div', {
    id: 'reply-modal',
    className: 'modal-backdrop',
    onclick: e => { if (e.target.id === 'reply-modal') closeReplyModal(); },
  },
    el('div', { className: 'modal' },
      el('div', { className: 'modal-title' }, `回复 #${m.id} ${m.desc.slice(0, 40)}${m.desc.length > 40 ? '…' : ''}`),
      extraBlock,
      el('label', { className: 'modal-label' }, '回复内容', replyInput),
      el('label', { className: 'modal-label inline' },
        resumeCheckbox,
        el('span', null, ' ' + resumeLabel(m.group)),
      ),
      noteBlock,
      errorBox,
      el('div', { className: 'modal-actions' },
        el('button', { className: 'btn', onclick: closeReplyModal }, '取消'),
        el('button', {
          className: 'btn',
          disabled: m.submitting,
          onclick: submitReplyAndCopyLoop,
          title: '落库 + 复制 loop 启动命令；粘贴到 terminal 即可让 claude 继续处理',
        }, '📋 提交并复制 loop 命令'),
        el('button', {
          className: 'btn primary',
          disabled: m.submitting,
          onclick: submitReply,
        }, m.submitting ? '提交中…' : '仅提交'),
      ),
    ),
  );
  document.body.appendChild(modal);
  replyInput.focus();
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

async function changePriority(id, priority) {
  if (!['高', '中', '低'].includes(priority)) return;
  await postAction(`/api/projects/${state.selectedSlug}/priority`, { id, priority });
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

async function wakeNowProject() {
  await postAction(`/api/projects/${state.selectedSlug}/wake-now`, {});
  await refreshProjects();
}

async function changeDesiredModel(model) {
  if (!['opus', 'sonnet', 'haiku'].includes(model)) return;
  const r = await postAction(`/api/projects/${state.selectedSlug}/desired-model`, { model });
  if (!r.ok) alert(`切换执行模型失败: ${r.body?.error || r.status}`);
  await refreshProjects();
}

async function changeTaskModel(id, model) {
  if (model !== '' && !['opus', 'sonnet', 'haiku'].includes(model)) return;
  const r = await postAction(
    `/api/projects/${state.selectedSlug}/tasks/${encodeURIComponent(id)}/model`,
    { model },
  );
  if (!r.ok) alert(`切换任务 #${id} 模型失败: ${r.body?.error || r.status}`);
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
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
