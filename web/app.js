'use strict';

const state = {
  projects: [],
  selectedSlug: null,
  detail: null,
  doneCollapsed: true,
  kanbanCollapsed: false,
  expandedCards: new Set(),
  addModal: null,
  loopCmdModal: null,
  replyModal: null,
  reopenModal: null,
  markDoneModal: null,
  imagePreview: null,
  cardDetailModal: null,
  historyModal: null,
  hiddenExpanded: false,
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

/**
 * 右下角非阻塞 toast。点击可立即关闭。
 * variant: 'info' | 'success' | 'warn' | 'error'
 */
function showToast(msg, variant = 'info', durationMs = 4000) {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = el('div', { id: 'toast-stack' });
    document.body.appendChild(stack);
  }
  const node = el('div', { className: `toast toast-${variant}` }, msg);
  stack.appendChild(node);
  requestAnimationFrame(() => node.classList.add('toast-in'));
  const close = () => {
    node.classList.remove('toast-in');
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 200);
  };
  const timer = setTimeout(close, durationMs);
  node.addEventListener('click', () => { clearTimeout(timer); close(); });
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
  if (e.key === 'Escape') { closeCardDetailModal(); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // 焦点在输入控件里时让位给原生光标移动
    const ae = document.activeElement;
    const tag = ae && ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (ae && ae.isContentEditable)) return;
    const siblings = getCardDetailSiblings();
    if (siblings.length <= 1) return;
    const cur = state.cardDetailModal && state.cardDetailModal.task;
    if (!cur) return;
    const idx = siblings.findIndex(x => String(x.id) === String(cur.id));
    if (idx < 0) return;
    const nextIdx = e.key === 'ArrowLeft'
      ? (idx === 0 ? siblings.length - 1 : idx - 1)
      : (idx === siblings.length - 1 ? 0 : idx + 1);
    state.cardDetailModal.task = siblings[nextIdx];
    e.preventDefault();
    renderCardDetailModal();
  }
}

/**
 * 推导 cardDetailModal 当前的"兄弟任务列表",用于 ← / → 切换:
 * - 当 history modal 也开着,且任务在 history items 里 → 用 history 列表
 * - 否则从看板对应 group 取
 */
function getCardDetailSiblings() {
  const m = state.cardDetailModal;
  if (!m || !m.task) return [];
  const tid = String(m.task.id);
  if (state.historyModal && Array.isArray(state.historyModal.items)) {
    if (state.historyModal.items.some(x => String(x.id) === tid)) {
      return state.historyModal.items;
    }
  }
  if (state.detail && state.detail.tasks && Array.isArray(state.detail.tasks[m.group])) {
    return state.detail.tasks[m.group];
  }
  return [];
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

/**
 * 构造 detail modal 内的子任务清单 section。
 * - done 状态只读:只显示进度条 + 勾选状态(灰)
 * - 其它状态可交互:checkbox 切换 / 点文本编辑 / × 删除 / 底部输入框追加
 *
 * 所有 mutation 走全量 PUT(submitChecklistUpdate),失败回滚由后端拒绝触发。
 *
 * @param {object} task
 * @param {string} group
 * @returns {HTMLElement}
 */
function buildChecklistSection(task, group) {
  const readOnly = group === 'done';
  const items = parseChecklistVal(task.checklist);
  const sum = checklistSummary(items);

  const header = el('div', { className: 'detail-section-title' },
    items.length === 0 ? '子任务清单' : `子任务清单 ${sum.done}/${sum.total}`,
  );

  // 进度条 —— 有 item 才显示
  const progressBar = items.length > 0
    ? el('div', { className: 'checklist-progress' },
        el('div', { className: 'checklist-progress-bar' },
          el('div', {
            className: 'checklist-progress-fill',
            style: `width: ${Math.round(sum.ratio * 100)}%`,
          }),
        ),
        el('div', { className: 'checklist-progress-meta' },
          items.length === 0 ? '—' : `${Math.round(sum.ratio * 100)}%`,
        ),
      )
    : null;

  // 找到"当前"项(第一个未勾)的下标,用来加 .current 高亮
  const currentIdx = items.findIndex(it => !it.done);

  // 行渲染
  const rows = items.map((it, idx) => {
    const checkbox = el('input', {
      type: 'checkbox',
      className: 'checklist-checkbox',
      ...(it.done ? { checked: '' } : {}),
      ...(readOnly ? { disabled: '' } : {}),
    });
    checkbox.addEventListener('change', () => {
      if (readOnly) return;
      const next = items.map((x, i) => i === idx ? { ...x, done: checkbox.checked } : x);
      submitChecklistUpdate(task.id, next);
    });

    // 文本:点击切换成 input;失焦/回车 commit
    let textNode;
    if (readOnly) {
      textNode = el('span', { className: 'checklist-text' + (it.done ? ' done' : '') }, it.text);
    } else {
      textNode = el('span', {
        className: 'checklist-text' + (it.done ? ' done' : '') + (idx === currentIdx ? ' current' : ''),
        title: '点击编辑',
        onclick: () => {
          // 替换成 input
          const input = el('input', {
            type: 'text',
            className: 'checklist-text-edit',
            value: it.text,
          });
          let committed = false;
          const commit = () => {
            if (committed) return;
            committed = true;
            const newText = input.value.trim();
            if (!newText || newText === it.text) {
              renderCardDetailModal();
              return;
            }
            const next = items.map((x, i) => i === idx ? { ...x, text: newText } : x);
            submitChecklistUpdate(task.id, next);
          };
          input.addEventListener('blur', commit);
          input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { committed = true; renderCardDetailModal(); }
          });
          textNode.replaceWith(input);
          input.focus();
          input.select();
        },
      }, it.text);
    }

    const children = [checkbox, textNode];
    if (idx === currentIdx && !readOnly) {
      children.push(el('span', { className: 'checklist-current-tag' }, '当前'));
    }
    if (!readOnly) {
      children.push(el('button', {
        className: 'checklist-del',
        type: 'button',
        title: '删除',
        onclick: () => {
          if (!confirm(`删除「${it.text}」?`)) return;
          const next = items.filter((_, i) => i !== idx);
          submitChecklistUpdate(task.id, next);
        },
      }, '×'));
    }

    return el('div', { className: 'checklist-row' + (it.done ? ' done' : '') }, ...children);
  });

  // 底部:加一项 input
  let addInput = null;
  if (!readOnly) {
    addInput = el('input', {
      type: 'text',
      className: 'checklist-add',
      placeholder: items.length === 0 ? '加第一项 (回车确认)…' : '+ 加一项 (回车确认)…',
    });
    addInput.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = addInput.value.trim();
      if (!text) return;
      const next = [...items, { text, done: false }];
      addInput.value = '';
      submitChecklistUpdate(task.id, next);
    });
  }

  const bodyChildren = [];
  if (progressBar) bodyChildren.push(progressBar);
  bodyChildren.push(...rows);
  if (addInput) bodyChildren.push(addInput);
  if (items.length === 0 && readOnly) {
    bodyChildren.push(el('div', { className: 'checklist-empty' }, '(无)'));
  }

  return el('div', { className: 'detail-section detail-section-checklist' },
    header,
    el('div', { className: 'detail-section-body' }, ...bodyChildren),
  );
}

const { parseNoteBlocks, classifyNoteBlock, splitReplyBody, splitContextLine } = window.NoteBlocks;

function renderNoteBlock(block) {
  const meta = classifyNoteBlock(block);
  const bodyText = block.bodyLines.join('\n');

  if (meta.kind === 'done') {
    return el('div', { className: 'note-block note-block-done' },
      el('div', { className: 'note-block-header' },
        el('span', { className: 'note-block-chip note-chip-done' }, '✓ 完成'),
        el('span', { className: 'note-block-when' }, meta.when || ''),
      ),
      el('div', { className: 'note-block-body' }, ...linkifyText(bodyText)),
    );
  }

  if (meta.kind === 'reply') {
    const cls = meta.latest ? 'note-block note-block-reply note-block-reply-latest'
                            : 'note-block note-block-reply note-block-reply-obsolete';
    const { contextLines, answerLines } = splitReplyBody(block.bodyLines);
    const contextNodes = [];
    if (contextLines.length) {
      const grouped = [];
      let curLabel = null;
      let curBuf = [];
      for (const ln of contextLines) {
        const sp = splitContextLine(ln);
        if (sp.label) {
          if (curBuf.length || curLabel) grouped.push({ label: curLabel, text: curBuf.join('\n') });
          curLabel = sp.label;
          curBuf = [sp.text];
        } else {
          curBuf.push(ln);
        }
      }
      if (curBuf.length || curLabel) grouped.push({ label: curLabel, text: curBuf.join('\n') });
      for (const g of grouped) {
        contextNodes.push(el('div', { className: 'note-reply-context-item' },
          g.label ? el('div', { className: 'note-reply-sublabel' }, g.label) : null,
          el('div', { className: 'note-reply-sub-body' }, ...linkifyText(g.text)),
        ));
      }
    }
    return el('div', { className: cls },
      el('div', { className: 'note-block-header' },
        el('span', { className: 'note-block-chip ' + (meta.latest ? 'note-chip-latest' : 'note-chip-obsolete') },
          meta.latest ? '💬 最新回复' : '🗂 历史回复'),
        meta.user ? el('span', { className: 'note-block-user' }, meta.user) : null,
        el('span', { className: 'note-block-when' }, meta.when || ''),
      ),
      contextNodes.length ? el('div', { className: 'note-reply-context' },
        el('div', { className: 'note-reply-sublabel-main' }, 'AI 此前提出'),
        ...contextNodes,
      ) : null,
      el('div', { className: 'note-reply-answer' },
        el('div', { className: 'note-reply-sublabel-main' }, (meta.user ? meta.user : '用户') + ' 的答复'),
        el('div', { className: 'note-reply-sub-body' }, ...linkifyText(answerLines.join('\n'))),
      ),
    );
  }

  // legacy / freeform
  return el('div', { className: 'note-block note-block-other' },
    block.header ? el('div', { className: 'note-block-header' },
      el('span', { className: 'note-block-chip note-chip-other' }, block.header),
    ) : null,
    el('div', { className: 'note-block-body' }, ...linkifyText(bodyText)),
  );
}

function renderNoteBlocks(note) {
  const blocks = parseNoteBlocks(note);
  if (!blocks.length) return el('div', { className: 'detail-section-body' }, ...linkifyText(note || ''));
  return el('div', { className: 'note-blocks' }, ...blocks.map(renderNoteBlock));
}

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

  // 子任务清单 —— done 状态只读,其它状态可编辑。
  sections.push(buildChecklistSection(t, group));

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
      renderNoteBlocks(t.note),
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
    actions.push(el('button', {
      className: 'btn',
      title: '直接标记为已完成并归档（不跑 commit）',
      onclick: () => {
        closeCardDetailModal();
        openMarkDoneModal(t, group);
      },
    }, '✓ 标完成'));
  }
  actions.push(el('button', { className: 'btn', onclick: closeCardDetailModal },
    getCardDetailSiblings().length > 1 ? '关闭 (ESC) · ← → 切换' : '关闭 (ESC)'));

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
  const all = state.projects;
  const missing = all.filter(p => p.online === 'missing');
  const visible = all.filter(p => p.online !== 'missing' && !p.hidden);
  const hidden = all.filter(p => p.online !== 'missing' && p.hidden);

  if (state.selectedSlug && hidden.some(p => p.slug === state.selectedSlug)) {
    state.selectedSlug = null;
    state.detail = null;
  }

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
        el('button', {
          className: 'hide-btn',
          title: '隐藏此项目',
          onclick: (ev) => { ev.stopPropagation(); setHidden(p.slug, true); },
        }, '×'),
      );
      list.appendChild(item);
    }
  }

  if (missing.length > 0) {
    list.appendChild(el('div', { className: 'hidden-hint' },
      el('span', null, `${missing.length} 个失联项目已隐藏`),
      el('button', {
        className: 'btn',
        onclick: () => cleanupMissing(missing.length),
      }, '清理'),
    ));
  }

  if (hidden.length > 0) {
    const expanded = state.hiddenExpanded === true;
    const section = el('div', { className: 'hidden-section' },
      el('button', {
        className: 'hidden-toggle',
        onclick: () => { state.hiddenExpanded = !expanded; renderProjects(); },
      }, `${expanded ? '▾' : '▸'} 已隐藏 (${hidden.length})`),
    );
    if (expanded) {
      const listEl = el('div', { className: 'hidden-list' });
      for (const p of hidden) {
        const item = el('div', { className: 'project-item dim' },
          el('div', { className: 'name' },
            el('span', { className: `dot ${p.online}` }), p.name,
          ),
          el('button', {
            className: 'show-btn btn',
            title: '从隐藏区恢复',
            onclick: (ev) => { ev.stopPropagation(); setHidden(p.slug, false); },
          }, '显示'),
        );
        listEl.appendChild(item);
      }
      section.appendChild(listEl);
    }
    list.appendChild(section);
  }
}

async function setHidden(slug, hidden) {
  const r = await postAction(`/api/projects/${slug}/hidden`, { hidden });
  if (!r.ok) {
    alert(`${hidden ? '隐藏' : '显示'}项目失败: ${r.body?.error || r.status}`);
    return;
  }
  if (!hidden) state.hiddenExpanded = true;
  await refreshProjects();
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
  const expanded = state.expandedCards.has(cardKey);
  // review 看风险,blocked 看疑问,done 看 note(commit hash / 模块 / 文件等审查信息)
  const extra = group === 'review' ? t.risk
    : group === 'blocked' ? t.question
    : group === 'done' ? t.note
    : '';
  const totalLen = (t.desc || '').length + (extra || '').length;
  const collapsible = totalLen > LONG_TEXT_THRESHOLD;
  const showCollapsed = collapsible && !expanded;

  const children = [
    el('div', { className: 'card-desc' },
      el('span', { className: 'card-id' }, `#${t.id}`),
      ...linkifyText(t.desc || ''),
    ),
    el('div', { className: 'card-chips' }, ...chips),
  ];

  // 紧凑 checklist 摘要 —— 只在有子项时渲染:迷你进度条 + 下一步未勾文本。
  // 详情(可编辑)走 detail modal,卡片上不可点击交互,避免误触。
  const checklistItems = parseChecklistVal(t.checklist);
  if (checklistItems.length > 0) {
    const s = checklistSummary(checklistItems);
    const pct = Math.round(s.ratio * 100);
    children.push(el('div', { className: 'card-progress' },
      el('div', { className: 'card-progress-bar' },
        el('div', { className: 'card-progress-fill', style: `width: ${pct}%` }),
      ),
      el('div', { className: 'card-progress-meta' }, `${s.done}/${s.total}`),
    ));
    if (s.nextUndone) {
      children.push(el('div', { className: 'card-next-step', title: '下一步' },
        el('span', { className: 'card-next-step-icon' }, '☐'),
        el('span', { className: 'card-next-step-text' }, s.nextUndone),
      ));
    }
  }

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
          if (expanded) state.expandedCards.delete(cardKey);
          else state.expandedCards.add(cardKey);
          renderDetail();
        },
      }, showCollapsed ? '▾ 展开' : '▴ 收起'),
    ));
  }

  if (group === 'done') {
    children.push(el('div', { className: 'card-actions' },
      el('button', {
        className: 'btn primary',
        onclick: (e) => { e.stopPropagation(); openReopenModal(t); },
      }, '回复重开'),
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
        el('button', {
          className: 'btn',
          title: '直接标记为已完成并归档（不跑 commit）',
          onclick: () => openMarkDoneModal(t, group),
        }, '✓ 标完成'),
        el('button', { className: 'btn danger', onclick: () => skipTask(t.id) }, 'skip'),
      ));
    }
  }

  return el('div', {
    className: 'card card-clickable' + (showCollapsed ? ' collapsed' : ''),
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
      el('span', { className: 'done-header-right' },
        el('a', {
          className: 'done-history-link',
          href: '#',
          onclick: e => { e.preventDefault(); e.stopPropagation(); openHistoryModal(); },
        }, '查看历史'),
        el('span', null, collapsed ? '▸ 展开' : '▾ 折叠'),
      ),
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
  // 每次重建 DOM 都把 done-body / column-body / kanban 的 scroll 位置重置成 0,
  // 用户滚到一半就被甩回原点。
  // 单实例容器按 selector 直接存;多实例容器(column-body 有 4 个)按出现顺序索引存。
  const savedScrollTop = {};
  const savedScrollLeft = {};
  const doneBody = c.querySelector('.done-body');
  if (doneBody) savedScrollTop['.done-body'] = doneBody.scrollTop;
  const kanban = c.querySelector('.kanban');
  if (kanban) savedScrollLeft['.kanban'] = kanban.scrollLeft;
  const colBodies = c.querySelectorAll('.column-body');
  const savedColumnScrolls = [];
  colBodies.forEach(node => savedColumnScrolls.push(node.scrollTop));

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
      : 'tmux 启动的 loop：把"扫一下"注入 stdin，~1s 响应；否则降级 wake-now 旗子（≤ idleSleepSeconds）',
    onclick: () => scanNowProject(),
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
    title: '生成 tmux 启动脚本（粘到 terminal 即跑；启动后 ⚡ 立即执行 通过 send-keys 即时唤醒）',
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

  for (const [sel, top] of Object.entries(savedScrollTop)) {
    const node = c.querySelector(sel);
    if (node) node.scrollTop = top;
  }
  for (const [sel, left] of Object.entries(savedScrollLeft)) {
    const node = c.querySelector(sel);
    if (node) node.scrollLeft = left;
  }
  const newColBodies = c.querySelectorAll('.column-body');
  newColBodies.forEach((node, i) => {
    if (savedColumnScrolls[i] != null) node.scrollTop = savedColumnScrolls[i];
  });

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
 * 把 row.checklist(JSON 字符串 / 数组 / null) 解析为 [{text, done}, ...]。
 * 与 lib/checklist.cjs 的 parseChecklist 行为对齐;前端独立实现以免双 import。
 * @param {unknown} raw
 * @returns {{text:string,done:boolean}[]}
 */
function parseChecklistVal(raw) {
  if (raw == null || raw === '') return [];
  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    try { arr = JSON.parse(String(raw)); } catch (_) { return []; }
    if (!Array.isArray(arr)) return [];
  }
  return arr.map(it => {
    if (typeof it === 'string') return { text: it, done: false };
    if (it && typeof it === 'object') {
      return { text: String(it.text ?? '').trim(), done: Boolean(it.done) };
    }
    return null;
  }).filter(it => it && it.text);
}

/**
 * 汇总 checklist 进度。
 * @param {{text:string,done:boolean}[]} items
 */
function checklistSummary(items) {
  const total = items.length;
  const done = items.filter(it => it.done).length;
  const next = items.find(it => !it.done);
  return { done, total, ratio: total === 0 ? 0 : done / total, nextUndone: next ? next.text : null };
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
    if (e.target.id === 'add-modal') tryCloseAddModal();
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

let _addModalEscHandler = null;

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
  _addModalEscHandler = e => { if (e.key === 'Escape') tryCloseAddModal(); };
  document.addEventListener('keydown', _addModalEscHandler);
  renderAddModal();
}

function closeAddModal() {
  if (_addModalEscHandler) {
    document.removeEventListener('keydown', _addModalEscHandler);
    _addModalEscHandler = null;
  }
  state.addModal = null;
  renderAddModal();
}

function isAddModalDirty() {
  const f = state.addModal;
  if (!f) return false;
  return !!(
    (f.desc || '').trim() ||
    (f.note || '').trim() ||
    (Array.isArray(f.tags) && f.tags.length) ||
    (Array.isArray(f.attachments) && f.attachments.length)
  );
}

function tryCloseAddModal() {
  if (!state.addModal) return;
  if (isAddModalDirty() && !confirm('表单已有内容,确认关闭?未提交内容会丢失')) return;
  closeAddModal();
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

/**
 * 处理 reply modal 中 textarea 的 paste 事件:
 * - 剪贴板含图片 → 拦截默认 paste,上传到 .tasks/attachments/,
 *   返回路径以新行形式插入到 textarea 光标位置(同时同步到 state.replyModal.reply)
 * - 仅文本 → 不拦截,走默认 paste
 *
 * 相比 handleModalPaste 简化:reply 没有 attachments 缩略图侧栏,
 * 路径直接写进文本即可,后端 reply 拼到 note 顶部,linkify 会自动渲染缩略图。
 *
 * @param {ClipboardEvent} e
 * @param {HTMLTextAreaElement} textarea reply 输入 DOM
 * @param {HTMLElement} statusBox modal 底部错误/状态盒子
 */
async function handleReplyPaste(e, textarea, statusBox) {
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

  // 把路径插入到光标位置(用 \n 包夹保证独占一行,linkify 才会识别)
  const m = state.replyModal;
  const cur = textarea.value || '';
  const selStart = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : cur.length;
  const selEnd = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : cur.length;
  const before = cur.slice(0, selStart);
  const after = cur.slice(selEnd);
  const needLeadingNL = before && !before.endsWith('\n') ? '\n' : '';
  const needTrailingNL = after && !after.startsWith('\n') ? '\n' : '';
  const inserted = `${needLeadingNL}${newPath}${needTrailingNL}`;
  const next = before + inserted + after;
  textarea.value = next;
  if (m) m.reply = next;
  // 还原光标到插入末尾
  const caret = (before + inserted).length;
  try { textarea.setSelectionRange(caret, caret); } catch (_) { /* noop */ }

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
    rows: 12,
    placeholder: m.loading ? '生成中…' : '',
  });
  cmdArea.value = m.command || '';
  cmdArea.addEventListener('focus', () => cmdArea.select());

  const hint = el('div', { className: 'modal-error' },
    m.error ? m.error
      : m.copied ? '✓ 已复制，去 terminal 粘贴即可启动 loop（tmux session 名: task-queue-loop-<slug>）'
      : '粘到 terminal 会起一个 tmux session 把 loop 跑在里面；⚡ 立即执行按钮会向这个 session send-keys "扫一下"',
  );

  const modal = el('div', {
    id: 'loop-cmd-modal',
    className: 'modal-backdrop',
    onclick: e => { if (e.target.id === 'loop-cmd-modal') closeLoopCmdModal(); },
  },
    el('div', { className: 'modal' },
      el('div', { className: 'modal-title' }, 'loop 启动脚本 (tmux)'),
      el('label', { className: 'modal-label' }, 'tmux 启动脚本（已替换 PROJECT_ROOT；启动后支持 ⚡ 即时唤醒）', cmdArea),
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

async function openHistoryModal(days) {
  const d = Number(days) || 30;
  state.historyModal = { loading: true, days: d, items: [], total: 0, error: '' };
  renderHistoryModal();
  try {
    const r = await fetch(`/api/projects/${state.selectedSlug}/history?days=${d}`);
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      state.historyModal = {
        loading: false,
        days: body.days || d,
        items: Array.isArray(body.items) ? body.items : [],
        total: body.total || 0,
        error: '',
      };
    } else {
      state.historyModal = { loading: false, days: d, items: [], total: 0, error: body.error || `失败 (${r.status})` };
    }
  } catch (err) {
    state.historyModal = { loading: false, days: d, items: [], total: 0, error: String(err.message) };
  }
  renderHistoryModal();
}

function closeHistoryModal() {
  state.historyModal = null;
  renderHistoryModal();
}

function renderHistoryModal() {
  const existing = document.getElementById('history-modal');
  if (existing) existing.remove();
  if (!state.historyModal) return;

  const m = state.historyModal;

  // 按日期(本地 YYYY-MM-DD)分组
  const groups = new Map();
  for (const t of m.items) {
    let key = '—';
    if (t.ftime) {
      const d = new Date(t.ftime);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        key = `${y}-${mo}-${da}`;
      }
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const groupKeys = Array.from(groups.keys()).sort((a, b) => b.localeCompare(a));

  const dayOptions = [7, 30, 90, 365];
  const filterRow = el('div', { className: 'history-filter' },
    el('span', null, '范围：'),
    ...dayOptions.map(n => el('button', {
      className: 'btn' + (m.days === n ? ' primary' : ''),
      disabled: m.loading,
      onclick: () => openHistoryModal(n),
    }, n >= 365 ? '一年' : `${n} 天`)),
    el('span', { className: 'history-meta' },
      m.loading ? '加载中…' : `共 ${m.total} 条${m.total > m.items.length ? `(显示前 ${m.items.length})` : ''}`,
    ),
  );

  const body = el('div', { className: 'history-body' });
  if (m.loading) {
    body.appendChild(el('div', { className: 'history-empty' }, '加载中…'));
  } else if (m.error) {
    body.appendChild(el('div', { className: 'modal-error' }, m.error));
  } else if (m.items.length === 0) {
    body.appendChild(el('div', { className: 'history-empty' }, `过去 ${m.days} 天暂无已完成任务`));
  } else {
    for (const key of groupKeys) {
      const list = groups.get(key);
      body.appendChild(el('div', { className: 'history-day-header' },
        el('span', null, key),
        el('span', { className: 'history-day-count' }, `${list.length} 条`),
      ));
      for (const t of list) body.appendChild(renderCard(t, 'done'));
    }
  }

  const modal = el('div', {
    id: 'history-modal',
    className: 'modal-backdrop',
    onclick: e => { if (e.target.id === 'history-modal') closeHistoryModal(); },
  },
    el('div', { className: 'modal modal-wide' },
      el('div', { className: 'modal-title' }, '历史已完成任务'),
      filterRow,
      body,
      el('div', { className: 'modal-actions' },
        el('button', { className: 'btn', onclick: closeHistoryModal }, '关闭'),
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
  alert('✓ 回复已落库（状态转回待办），tmux 启动脚本已复制到剪贴板，去 terminal 粘贴即可让 loop 接手');
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

  // reply textarea 绑 paste handler:剪贴板含图片 → 上传到 .tasks/attachments/,
  // 路径插到光标位置,linkify 会把路径渲染成缩略图。
  replyInput.addEventListener('paste', e => handleReplyPaste(e, replyInput, errorBox));

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

function openReopenModal(task) {
  state.reopenModal = {
    id: task.id,
    desc: task.desc || '',
    note: task.note || '',
    reply: '',
    error: '',
    submitting: false,
  };
  renderReopenModal();
}

function closeReopenModal() {
  state.reopenModal = null;
  renderReopenModal();
}

async function submitReopen() {
  const m = state.reopenModal;
  if (!m || m.submitting) return;
  if (!m.reply.trim()) { m.error = '回复内容不能为空'; renderReopenModal(); return; }
  m.submitting = true; m.error = ''; renderReopenModal();

  const r = await postAction(`/api/projects/${state.selectedSlug}/reopen`, {
    id: m.id, reply: m.reply.trim(),
  });
  if (r.ok) {
    closeReopenModal();
    if (state.historyModal) await openHistoryModal(state.historyModal.days);
    await refreshProjects();
  } else {
    m.submitting = false;
    m.error = r.body?.error || `失败 (${r.status})`;
    renderReopenModal();
  }
}

function renderReopenModal() {
  const existing = document.getElementById('reopen-modal');
  if (existing) existing.remove();
  if (!state.reopenModal) return;
  const m = state.reopenModal;

  const replyInput = el('textarea', {
    className: 'modal-input', rows: 5,
    placeholder: '回复内容（提交后任务带着完整历史重新进入待办，交给 loop 重做）',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
  });
  replyInput.value = m.reply || '';
  bindImeSafeInput(replyInput, v => { m.reply = v; });

  const modal = el('div', {
    id: 'reopen-modal', className: 'modal-backdrop',
    onclick: e => { if (e.target.id === 'reopen-modal') closeReopenModal(); },
  },
    el('div', { className: 'modal' },
      el('div', { className: 'modal-title' }, `回复重开 #${m.id} ${m.desc.slice(0, 40)}${m.desc.length > 40 ? '…' : ''}`),
      el('label', { className: 'modal-label' }, '回复内容', replyInput),
      m.error ? el('div', { className: 'modal-error' }, m.error) : null,
      el('div', { className: 'modal-actions' },
        el('button', { className: 'btn', onclick: closeReopenModal }, '取消'),
        el('button', { className: 'btn primary', disabled: m.submitting, onclick: submitReopen },
          m.submitting ? '提交中…' : '重开为待办'),
      ),
    ),
  );
  document.body.appendChild(modal);
  replyInput.focus();
}

function openMarkDoneModal(task, group) {
  state.markDoneModal = {
    id: task.id,
    group,
    desc: task.desc || '',
    extra: group === 'review' ? (task.risk || '') : (task.question || ''),
    summary: '',
    error: '',
    submitting: false,
  };
  renderMarkDoneModal();
}

function closeMarkDoneModal() {
  state.markDoneModal = null;
  renderMarkDoneModal();
}

async function submitMarkDone() {
  const m = state.markDoneModal;
  if (!m || m.submitting) return;
  if (!m.summary.trim()) {
    m.error = '说明不能为空（写一句话解释为什么直接标完成即可）';
    renderMarkDoneModal();
    return;
  }
  m.submitting = true;
  m.error = '';
  renderMarkDoneModal();

  const r = await postAction(`/api/projects/${state.selectedSlug}/mark-done`, {
    id: m.id,
    summary: m.summary.trim(),
  });
  if (r.ok) {
    closeMarkDoneModal();
    await refreshProjects();
  } else {
    m.submitting = false;
    m.error = r.body?.error || `失败 (${r.status})`;
    renderMarkDoneModal();
  }
}

function renderMarkDoneModal() {
  const existing = document.getElementById('mark-done-modal');
  if (existing) existing.remove();
  if (!state.markDoneModal) return;

  const m = state.markDoneModal;

  const summaryInput = el('textarea', {
    className: 'modal-input',
    rows: 4,
    placeholder: '说明：为什么这条直接算完成？（必填，写到归档 [done] 块里）',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  summaryInput.value = m.summary || '';
  bindImeSafeInput(summaryInput, v => { m.summary = v; });

  const extraBlock = m.extra ? el('div', { className: 'reply-extra' },
    el('div', { className: 'reply-extra-label' }, m.group === 'review' ? '原 风险' : '原 疑问'),
    el('div', { className: 'reply-extra-body' }, ...linkifyText(m.extra)),
  ) : null;

  const errorBox = el('div', { className: 'modal-error' }, m.error || '');

  const modal = el('div', {
    id: 'mark-done-modal',
    className: 'modal-backdrop',
    onclick: e => { if (e.target.id === 'mark-done-modal') closeMarkDoneModal(); },
  },
    el('div', { className: 'modal' },
      el('div', { className: 'modal-title' }, `标记完成 #${m.id} ${m.desc.slice(0, 40)}${m.desc.length > 40 ? '…' : ''}`),
      extraBlock,
      el('label', { className: 'modal-label' }, '说明', summaryInput),
      errorBox,
      el('div', { className: 'modal-actions' },
        el('button', { className: 'btn', onclick: closeMarkDoneModal }, '取消'),
        el('button', {
          className: 'btn primary',
          disabled: m.submitting,
          onclick: submitMarkDone,
        }, m.submitting ? '提交中…' : '✓ 标记完成并归档'),
      ),
    ),
  );
  document.body.appendChild(modal);
  summaryInput.focus();
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
  const r = await postAction(`/api/projects/${state.selectedSlug}/skip`, { id });
  if (!r.ok) {
    alert(`跳过失败 (HTTP ${r.status}): ${r.body?.error || '未知错误'}`);
    return;
  }
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

async function scanNowProject() {
  const r = await postAction(`/api/projects/${state.selectedSlug}/scan-now`, {});
  if (!r.ok) {
    showToast(`立即执行失败 (HTTP ${r.status}): ${r.body?.error || '未知错误'}`, 'error', 5000);
    return;
  }
  if (r.body?.mode === 'tmux') {
    showToast('已通过 tmux 注入"扫一下"；loop 当前若正忙，会在当前 turn 结束后处理', 'success');
  } else if (r.body?.mode === 'wake-flag') {
    showToast('降级 wake-now 旗子(tmux 不可用)；loop ≤ idleSleepSeconds 内响应', 'warn', 5000);
  }
  // 先 refresh 一次：wake-flag 模式立刻把 ⏳ 唤醒中 UI 反馈出来
  await refreshProjects();
  // tmux 模式 loop ~1-2s 内会跑完 Step 0.5+next+claim，1.5s 延迟再 refresh 让卡片可视化挪到「进行中」
  if (r.body?.mode === 'tmux') {
    setTimeout(() => { refreshProjects().catch(() => {}); }, 1500);
  }
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

/**
 * 提交整个 checklist(全量替换),成功后刷新并重渲染 detail modal。
 * @param {number|string} id 任务 id
 * @param {{text:string,done:boolean}[]} items 新数组
 */
async function submitChecklistUpdate(id, items) {
  const r = await postAction(
    `/api/projects/${state.selectedSlug}/tasks/${encodeURIComponent(id)}/checklist`,
    { items },
  );
  if (!r.ok) {
    alert(`保存清单失败: ${r.body?.error || r.status}`);
    return;
  }
  // 同步刷新本地 task 引用,避免 modal 关闭前看到旧数据。
  if (state.cardDetailModal && String(state.cardDetailModal.task.id) === String(id)) {
    state.cardDetailModal.task.checklist = JSON.stringify(r.body.items || []);
  }
  await refreshProjects();
  // 项目刷新后 state.detail.tasks 已更新,从中找到本任务最新引用,确保下次重渲染数据一致。
  if (state.cardDetailModal) {
    const groups = state.detail?.tasks || {};
    for (const k of Object.keys(groups)) {
      const found = (groups[k] || []).find(x => String(x.id) === String(id));
      if (found) { state.cardDetailModal.task = found; break; }
    }
    renderCardDetailModal();
  }
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
