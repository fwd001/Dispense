'use strict';

/* ==================================================================
   配置下发器 —— 前端
   无框架、无构建，原生模块脚本。
   视图：应用列表 / 应用详情 / 回收站（hash 路由）
   ================================================================== */

/* ----------------------------- 小工具 ----------------------------- */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (v) => String(v).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.keys(attrs || {}).forEach((key) => {
    if (key === 'class') node.className = attrs[key];
    else if (key === 'text') node.textContent = attrs[key];
    else if (key === 'html') node.innerHTML = attrs[key];
    else if (key === 'dataset') Object.assign(node.dataset, attrs[key]);
    else if (key in node && key !== 'list') node[key] = attrs[key];
    else node.setAttribute(key, attrs[key]);
  });
  (children || []).forEach((child) => node.appendChild(child));
  return node;
}

/* ------------------------------ 请求 ------------------------------ */

const api = {
  async request(method, path, body) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const res = await fetch(path, options);
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok || (json && json.ok === false)) {
      const error = new Error((json && json.error) || ('请求失败（' + res.status + '）'));
      error.code = json && json.code;
      error.details = json && json.details;
      error.status = res.status;
      throw error;
    }
    return json || { ok: true };
  },
  get: (p) => api.request('GET', p),
  post: (p, b) => api.request('POST', p, b),
  patch: (p, b) => api.request('PATCH', p, b),
  put: (p, b) => api.request('PUT', p, b),
  del: (p) => api.request('DELETE', p)
};

/* ------------------------------ Toast ------------------------------ */

function toast(message, kind) {
  const stack = $('#toastStack');
  const node = el('div', { class: 'toast' + (kind ? ' is-' + kind : ''), text: message });
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

/** 复制到剪贴板：优先 Clipboard API，失败则回退到隐藏 textarea + execCommand */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 继续回退 */ }
  try {
    const helper = el('textarea', { value: text });
    helper.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/* ------------------------------ 弹层 ------------------------------ */

const modal = {
  root: null,
  lastFocus: null,

  init() {
    this.root = {
      overlay: $('#overlay'),
      title: $('#modalTitle'),
      body: $('#modalBody'),
      actions: $('#modalActions')
    };
    this.root.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.root.overlay) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.root.overlay.hidden) this.close();
    });
  },

  open(options) {
    if (!this.root.overlay.hidden) this.close();
    this.lastFocus = document.activeElement;
    this.root.title.textContent = options.title || '';
    this.root.body.innerHTML = '';
    if (typeof options.body === 'string') this.root.body.innerHTML = options.body;
    else if (options.body) this.root.body.appendChild(options.body);

    this.root.actions.innerHTML = '';
    (options.actions || []).forEach((action) => {
      const button = el('button', {
        class: 'btn ' + (action.variant || 'btn-quiet'),
        text: action.label
      });
      button.addEventListener('click', async () => {
        if (action.keepOpen) { await action.onClick(); return; }
        const shouldClose = await action.onClick();
        if (shouldClose !== false) this.close();
      });
      this.root.actions.appendChild(button);
    });

    this.root.overlay.hidden = false;
    const focusTarget = this.root.body.querySelector('input, textarea, button') ||
      this.root.actions.querySelector('button');
    if (focusTarget) focusTarget.focus();
  },

  close() {
    this.root.overlay.hidden = true;
    this.root.body.innerHTML = '';
    this.root.actions.innerHTML = '';
    if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
  }
};

/** 二次确认弹窗 */
function confirmDialog(options) {
  return new Promise((resolve) => {
    modal.open({
      title: options.title || '确认操作',
      body: '<p class="modal-note">' + esc(options.message || '') + '</p>',
      actions: [
        { label: '取消', variant: 'btn-quiet', onClick: () => resolve(false) },
        {
          label: options.confirmText || '确定',
          variant: options.danger ? 'btn btn-danger' : 'btn btn-pop',
          onClick: () => resolve(true)
        }
      ]
    });
  });
}

/* ------------------------------ 状态 ------------------------------ */

const state = {
  limits: {},
  publicBaseUrl: '',
  apps: [],
  stats: { totalApplications: 0, totalFiles: 0 },
  app: null,
  trash: { files: [], applications: [] },
  trashTab: 'files'
};

async function refreshLimits() {
  const res = await api.get('/api/config');
  state.limits = res.config || {};
  state.publicBaseUrl = res.publicBaseUrl || '';
}

function deliverUrl(token) {
  const path = '/d/' + token;
  return state.publicBaseUrl ? state.publicBaseUrl + path : location.origin + path;
}

/* ============================ 视图：应用列表 ============================ */

function renderCreatePanel() {
  const form = el('form', { class: 'upload-grid', id: 'createForm' });
  const nameInput = el('input', {
    type: 'text',
    id: 'newAppName',
    placeholder: '应用名称，例如 MyApp',
    maxLength: '60',
    required: true,
    'aria-label': '应用名称'
  });
  const submit = el('button', { class: 'btn btn-pop', type: 'submit', text: '创建应用' });

  form.appendChild(el('div', { class: 'field' }, [
    el('label', { text: '新建应用', for: 'newAppName' }),
    nameInput
  ]));
  form.appendChild(el('div', { class: 'field' }, [
    el('span', { class: 'field-label', text: '　' }),
    submit
  ]));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    submit.disabled = true;
    submit.textContent = '创建中…';
    try {
      await api.post('/api/applications', { name });
      nameInput.value = '';
      toast('应用「' + name + '」已创建', 'ok');
      await renderApps();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      submit.disabled = false;
      submit.textContent = '创建应用';
    }
  });

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'section-title', text: '创建应用' }),
      el('p', {
        class: 'hint',
        text: '一个应用 = 一个永久下发链接。上限 ' +
          (state.limits.maxApplications || 100) + ' 个应用。'
      })
    ]),
    form
  ]);
}

function renderAppCard(app) {
  const card = el('article', { class: 'app-card' });

  const head = el('div', {}, [
    el('h3', { text: app.name }),
    el('div', { class: 'app-card-meta' }, [
      el('span', { text: app.fileCount + ' 个文件' }),
      el('span', { text: '更新于 ' + fmtDate(app.updatedAt) })
    ])
  ]);

  const current = el('div', { class: 'field' }, [
    el('span', { class: 'field-label', text: '当前下发' })
  ]);
  if (app.currentFileName) {
    current.appendChild(el('div', { class: 'deliver-value' }, [
      el('span', { class: 'tag tag-live', text: '● 已发布' }),
      document.createTextNode(' ' + app.currentFileName)
    ]));
  } else {
    current.appendChild(el('div', { class: 'deliver-value' }, [
      el('span', { class: 'tag tag-idle', text: '暂停下发' })
    ]));
  }

  const url = deliverUrl(app.token);
  const chip = el('div', { class: 'link-chip' }, [
    el('code', { text: url, title: url }),
    (() => {
      const button = el('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '复制' });
      button.addEventListener('click', async () => {
        const ok = await copyText(url);
        toast(ok ? '下发链接已复制' : '复制失败，请手动选择复制', ok ? 'ok' : 'err');
      });
      return button;
    })()
  ]);

  const actions = el('div', { class: 'btn-row' }, [
    (() => {
      const button = el('a', { class: 'btn', text: '进入应用', href: '#/apps/' + app.id });
      return button;
    })(),
    (() => {
      const button = el('button', { class: 'btn btn-quiet', type: 'button', text: '删除' });
      button.addEventListener('click', () => removeApplication(app));
      return button;
    })()
  ]);

  card.appendChild(head);
  card.appendChild(current);
  card.appendChild(el('div', { class: 'field' }, [
    el('span', { class: 'field-label', text: '下发链接' }),
    chip
  ]));
  card.appendChild(actions);
  return card;
}

async function renderApps() {
  const view = $('#view');
  view.innerHTML = '';
  await loadApps();

  view.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('h2', { class: 'page-title', text: '应用' }),
      el('p', {
        class: 'page-sub',
        text: '共 ' + state.stats.totalApplications + ' 个应用 / ' +
          state.stats.totalFiles + ' 个文件。核心流程：创建应用 → 上传文件 → 设为当前下发 → 复制链接。'
      })
    ])
  ]));

  view.appendChild(renderCreatePanel());

  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'section-title', text: '应用列表' })
    ])
  ]);

  if (!state.apps.length) {
    panel.appendChild(el('div', { class: 'empty' }, [
      el('span', { class: 'empty-mark', text: '◍' }),
      el('div', { text: '还没有应用，先创建一个吧。' })
    ]));
  } else {
    const grid = el('div', { class: 'app-grid' });
    state.apps.forEach((app) => grid.appendChild(renderAppCard(app)));
    panel.appendChild(grid);
  }
  view.appendChild(panel);
}

async function loadApps() {
  const res = await api.get('/api/applications');
  state.apps = res.data.applications || [];
  state.stats = res.data.stats || state.stats;
}

/* ============================ 视图：应用详情 ============================ */

async function renderAppDetail(appId) {
  const view = $('#view');
  view.innerHTML = '';

  let res;
  try {
    res = await api.get('/api/applications/' + appId);
  } catch (err) {
    view.appendChild(el('div', { class: 'empty', text: err.message }));
    return;
  }

  const app = res.application;
  state.app = app;

  /* 头部 */
  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('a', { class: 'crumb', href: '#/apps', text: '← 返回应用列表' }),
      el('h2', { class: 'page-title', text: app.name }),
      el('p', {
        class: 'page-sub',
        text: '创建于 ' + fmtDate(app.createdAt) + ' · 共 ' + app.files.length + ' 个文件'
      })
    ]),
    el('div', { class: 'btn-row' }, [
      (() => {
        const button = el('button', { class: 'btn btn-quiet', type: 'button', text: '重命名' });
        button.addEventListener('click', () => renameApplication(app));
        return button;
      })(),
      (() => {
        const button = el('button', { class: 'btn btn-quiet', type: 'button', text: '删除应用' });
        button.addEventListener('click', () => removeApplication(app));
        return button;
      })()
    ])
  ]);
  view.appendChild(head);

  /* 下发信息条 */
  view.appendChild(renderDeliverBar(app));

  /* 上传 */
  view.appendChild(renderUploadPanel(app));

  /* 文件列表 */
  view.appendChild(renderFilePanel(app));

  /* 历史 */
  view.appendChild(await renderHistoryPanel(app));
}

function renderDeliverBar(app) {
  const currentFile = app.files.find((f) => f.id === app.currentFileId);
  const url = deliverUrl(app.token);

  const currentBox = el('div', { class: 'deliver-item field' }, [
    el('span', { class: 'field-label', text: '当前下发文件' })
  ]);
  const currentValue = el('div', { class: 'deliver-value' });
  if (currentFile) {
    currentValue.appendChild(el('span', { class: 'tag tag-live', text: '● 正在下发' }));
    currentValue.appendChild(document.createTextNode(' ' + currentFile.name));
    if (currentFile.downloadName && currentFile.downloadName !== currentFile.name) {
      currentValue.appendChild(el('span', {
        class: 'cell-sub',
        text: '（对外文件名：' + currentFile.downloadName + '）'
      }));
    }
  } else {
    currentValue.appendChild(el('span', { class: 'tag tag-idle', text: '暂停下发' }));
    currentValue.appendChild(document.createTextNode(' 链接暂时返回 404'));
  }
  currentBox.appendChild(currentValue);

  const linkBox = el('div', { class: 'deliver-item deliver-item--link field' }, [
    el('span', { class: 'field-label', text: '下发链接（唯一且永久）' }),
    el('div', { class: 'deliver-link' }, [
      el('code', { text: url, title: url }),
      (() => {
        const button = el('button', { class: 'btn btn-sm', type: 'button', text: '复制' });
        button.addEventListener('click', async () => {
          const ok = await copyText(url);
          toast(ok ? '下发链接已复制' : '复制失败，请手动选择复制', ok ? 'ok' : 'err');
        });
        return button;
      })(),
      (() => {
        const button = el('a', {
          class: 'btn btn-quiet btn-sm',
          text: '打开',
          href: url,
          target: '_blank',
          rel: 'noreferrer'
        });
        return button;
      })()
    ])
  ]);

  const actions = el('div', { class: 'deliver-item field' }, [
    el('span', { class: 'field-label', text: '发布控制' }),
    el('div', { class: 'btn-row' }, [
      (() => {
        const button = el('button', {
          class: 'btn btn-quiet btn-sm',
          type: 'button',
          text: app.currentFileId ? '暂停下发' : '暂无操作'
        });
        button.disabled = !app.currentFileId;
        button.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '暂停下发',
            message: '暂停后访问下发链接将返回 404。应用与文件都会保留，可随时重新发布。',
            confirmText: '暂停下发'
          });
          if (!ok) return;
          try {
            await api.post('/api/applications/' + app.id + '/current-file', { fileId: null });
            toast('已暂停下发', 'ok');
            renderAppDetail(app.id);
          } catch (err) { toast(err.message, 'err'); }
        });
        return button;
      })()
    ])
  ]);

  return el('section', { class: 'deliver-bar' }, [currentBox, linkBox, actions]);
}

function renderUploadPanel(app) {
  const input = el('input', {
    type: 'file',
    id: 'fileInput',
    multiple: true,
    accept: (state.limits.allowedExtensions || []).map((e) => '.' + e).join(',')
  });
  const nameOverride = el('input', {
    type: 'text',
    id: 'uploadName',
    placeholder: '可选：自定义文件名（留空用原文件名）',
    'aria-label': '自定义文件名'
  });

  const zone = el('div', { class: 'dropzone', id: 'dropzone' }, [
    el('p', {
      text: '把配置文件拖到这里，或点击选择文件。单文件最大 ' +
        Math.floor((state.limits.maxFileSize || 3145728) / 1024 / 1024) + 'MB。'
    }),
    input
  ]);

  ['dragenter', 'dragover'].forEach((type) => {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach((type) => {
    zone.addEventListener(type, () => zone.classList.remove('is-over'));
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(app, e.dataTransfer.files, nameOverride.value);
  });

  input.addEventListener('change', () => {
    if (input.files && input.files.length) uploadFiles(app, input.files, nameOverride.value);
  });

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'section-title', text: '上传文件' }),
      el('p', { class: 'hint', text: '上传 ≠ 发布。上传后必须手动「设为当前下发」才会影响线上链接。' })
    ]),
    el('div', { class: 'upload-grid' }, [zone, el('div', { class: 'field' }, [
      el('label', { text: '文件名（可选）', for: 'uploadName' }),
      nameOverride
    ])])
  ]);
}

async function uploadFiles(app, fileList, nameOverride) {
  const files = Array.from(fileList);
  for (const file of files) {
    try {
      if (file.size > (state.limits.maxFileSize || 3145728)) {
        toast('「' + file.name + '」超过 ' +
          Math.floor(state.limits.maxFileSize / 1024 / 1024) + 'MB 限制', 'err');
        continue;
      }
      const text = await file.text();
      const res = await api.post('/api/applications/' + app.id + '/files', {
        name: (nameOverride && files.length === 1 ? nameOverride : file.name),
        content: text
      });
      toast('已上传：' + res.file.name + '（未发布）', 'ok');
    } catch (err) {
      toast('上传「' + file.name + '」失败：' + err.message, 'err');
    }
  }
  renderAppDetail(app.id);
}

function renderFilePanel(app) {
  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'section-title', text: '文件列表' }),
      el('p', { class: 'hint', text: '按上传时间倒序；带「当前下发」标记的就是线上正在返回的文件。' })
    ])
  ]);

  if (!app.files.length) {
    panel.appendChild(el('div', { class: 'empty' }, [
      el('span', { class: 'empty-mark', text: '◇' }),
      el('div', { text: '还没有文件，先上传一份配置。' })
    ]));
    return panel;
  }

  const table = el('table', { class: 'data' });
  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', { text: '文件名' }),
      el('th', { text: '大小' }),
      el('th', { text: '上传时间' }),
      el('th', { text: '操作' })
    ])
  ]);
  const tbody = el('tbody');

  app.files.forEach((file) => {
    const isCurrent = app.currentFileId === file.id;
    const row = el('tr', { class: isCurrent ? 'is-current' : '' });

    const nameCell = el('td', { dataset: { label: '文件名' } }, [
      el('div', { class: 'cell-name' }, [
        el('span', { text: file.name }),
        isCurrent ? el('span', { class: 'tag tag-live', text: '当前下发' }) : null,
        file.broken ? el('span', { class: 'tag tag-broken', text: '实体缺失' }) : null,
        file.downloadName && file.downloadName !== file.name
          ? el('span', { class: 'cell-sub', text: '下发名 ' + file.downloadName })
          : null
      ].filter(Boolean))
    ]);

    const sizeCell = el('td', { dataset: { label: '大小' }, text: fmtBytes(file.size) });
    const timeCell = el('td', { dataset: { label: '上传时间' }, text: fmtDate(file.createdAt) });

    const actionCell = el('td', { dataset: { label: '操作' } });
    const actions = el('div', { class: 'cell-actions' });

    const publishButton = el('button', {
      class: 'btn btn-sm ' + (isCurrent ? 'btn-quiet' : 'btn-pop'),
      type: 'button',
      text: isCurrent ? '已发布' : '设为当前下发'
    });
    publishButton.disabled = isCurrent;
    publishButton.addEventListener('click', async () => {
      try {
        await api.post('/api/applications/' + app.id + '/current-file', { fileId: file.id });
        toast('已发布：' + file.name + '（链接未变）', 'ok');
        renderAppDetail(app.id);
      } catch (err) { toast(err.message, 'err'); }
    });
    actions.appendChild(publishButton);

    const editButton = el('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '编辑' });
    editButton.addEventListener('click', () => openEditor(app, file));
    actions.appendChild(editButton);

    const saveAsButton = el('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '另存为' });
    saveAsButton.addEventListener('click', async () => {
      try {
        const res = await api.post('/api/files/' + file.id + '/duplicate', {});
        toast('已另存为：' + res.file.name, 'ok');
        renderAppDetail(app.id);
      } catch (err) { toast(err.message, 'err'); }
    });
    actions.appendChild(saveAsButton);

    actions.appendChild(el('a', {
      class: 'btn btn-quiet btn-sm',
      text: '下载',
      href: '/api/files/' + file.id + '/download'
    }));

    const deleteButton = el('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '删除' });
    deleteButton.addEventListener('click', () => deleteFileWithGuard(app, file));
    actions.appendChild(deleteButton);

    actionCell.appendChild(actions);
    row.appendChild(nameCell);
    row.appendChild(sizeCell);
    row.appendChild(timeCell);
    row.appendChild(actionCell);
    tbody.appendChild(row);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  panel.appendChild(el('div', { class: 'table-wrap' }, [table]));

  panel.appendChild(el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
    (() => {
      const button = el('button', { class: 'btn btn-danger', type: 'button', text: '删除全部文件' });
      button.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '删除全部文件',
          message: '该应用的 ' + app.files.length + ' 个文件将全部进入回收站，应用本身保留，下发链接暂停。7 天后自动清理。',
          confirmText: '全部移入回收站',
          danger: true
        });
        if (!ok) return;
        try {
          const res = await api.del('/api/applications/' + app.id + '/files');
          toast(res.deleted.count + ' 个文件已移入回收站', 'ok');
          renderAppDetail(app.id);
        } catch (err) { toast(err.message, 'err'); }
      });
      return button;
    })()
  ]));

  return panel;
}

/**
 * 删除当前下发文件时的保护：不静默删除，让用户选「切换后删」还是「删了并暂停」。
 */
async function deleteFileWithGuard(app, file) {
  const isCurrent = app.currentFileId === file.id;
  if (!isCurrent) {
    const ok = await confirmDialog({
      title: '删除文件',
      message: '「' + file.name + '」将移入回收站，7 天后自动清理。',
      confirmText: '移入回收站',
      danger: true
    });
    if (!ok) return;
    try {
      await api.del('/api/files/' + file.id);
      toast('已移入回收站：' + file.name, 'ok');
      renderAppDetail(app.id);
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  // 当前正在下发：先尝试删除，服务端会返回 409 + 候选列表
  let error = null;
  try {
    await api.del('/api/files/' + file.id);
    toast('已移入回收站，下发已暂停', 'ok');
    renderAppDetail(app.id);
    return;
  } catch (err) {
    if (err.code !== 'DELETE_CURRENT_FILE') { toast(err.message, 'err'); return; }
    error = err;
  }

  const alternatives = (error.details && error.details.alternatives) || [];
  const list = el('ul', { class: 'choice-list' });

  alternatives.forEach((alt) => {
    const item = el('li', {}, [
      (() => {
        const button = el('button', { type: 'button', text: '先切换到「' + alt.name + '」再删除' });
        button.addEventListener('click', async () => {
          try {
            await api.post('/api/applications/' + app.id + '/current-file', { fileId: alt.id });
            await api.del('/api/files/' + file.id);
            toast('已切换到「' + alt.name + '」，原文件移入回收站', 'ok');
            modal.close();
            renderAppDetail(app.id);
          } catch (e) { toast(e.message, 'err'); }
        });
        return button;
      })()
    ]);
    list.appendChild(item);
  });

  const body = document.createDocumentFragment();
  body.appendChild(el('p', {
    class: 'modal-note',
    text: '「' + file.name + '」正在作为下发文件使用。删除后下发链接将没有可用文件，请选择一个处理方式：'
  }));
  body.appendChild(list);

  modal.open({
    title: '当前文件正在下发',
    body,
    actions: [
      { label: '取消', variant: 'btn-quiet', onClick: () => {} },
      {
        label: '删除并暂停下发',
        variant: 'btn btn-danger',
        onClick: async () => {
          try {
            await api.del('/api/files/' + file.id + '?force=1');
            toast('已移入回收站，下发已暂停', 'ok');
            renderAppDetail(app.id);
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]
  });
}

async function renderHistoryPanel(app) {
  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'section-title', text: '历史记录' })
    ])
  ]);
  let items = [];
  try {
    const res = await api.get('/api/applications/' + app.id + '/history?limit=50');
    items = res.history || [];
  } catch (e) { /* 历史读不到不影响主流程 */ }

  if (!items.length) {
    panel.appendChild(el('p', { class: 'hint', text: '暂无历史记录。' }));
    return panel;
  }

  const list = el('ul', { class: 'history-list' });
  items.forEach((item) => {
    list.appendChild(el('li', {}, [
      el('span', { class: 'history-time', text: fmtDate(item.ts) }),
      el('span', { class: 'history-text', html: describeHistory(item) })
    ]));
  });
  panel.appendChild(list);
  return panel;
}

function describeHistory(item) {
  const name = item.fileName ? '<strong>' + esc(item.fileName) + '</strong>' : '';
  const map = {
    app_created: '创建应用',
    app_renamed: '重命名应用',
    app_deleted: '删除应用',
    app_restored: '恢复应用',
    upload: '上传文件 ' + name,
    edit: '编辑文件 ' + name,
    rename: '重命名文件 ' + name,
    save_as: '另存为新文件 ' + name,
    set_current: '设置当前下发为 ' + name,
    unset_current: '暂停下发',
    delete: '删除文件 ' + name,
    delete_all: '删除全部文件',
    restore: '从回收站恢复 ' + name
  };
  return map[item.type] || item.type;
}

/* ============================ 应用级操作 ============================ */

function renameApplication(app) {
  const input = el('input', { type: 'text', value: app.name, maxLength: '60', 'aria-label': '应用名称' });
  modal.open({
    title: '重命名应用',
    body: el('div', { class: 'field' }, [
      el('label', { text: '应用名称' }),
      input
    ]),
    actions: [
      { label: '取消', variant: 'btn-quiet', onClick: () => {} },
      {
        label: '保存',
        variant: 'btn',
        onClick: async () => {
          const name = input.value.trim();
          if (!name) { toast('应用名称不能为空', 'err'); return false; }
          try {
            await api.patch('/api/applications/' + app.id, { name });
            toast('已重命名', 'ok');
            renderAppDetail(app.id);
          } catch (err) { toast(err.message, 'err'); }
        }
      }
    ]
  });
}

async function removeApplication(app) {
  const ok = await confirmDialog({
    title: '删除应用',
    message: '应用「' + app.name + '」及其全部文件都会进入回收站，7 天后自动清理。下发链接将失效。',
    confirmText: '删除应用',
    danger: true
  });
  if (!ok) return;
  try {
    await api.del('/api/applications/' + app.id);
    toast('应用已移入回收站', 'ok');
    location.hash = '#/apps';
    renderApps();
  } catch (err) { toast(err.message, 'err'); }
}

/* ============================ 编辑器 ============================ */

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}\[\],:])/g;

function highlightJson(text) {
  let out = '';
  let last = 0;
  let match;
  JSON_TOKEN.lastIndex = 0;
  while ((match = JSON_TOKEN.exec(text)) !== null) {
    out += esc(text.slice(last, match.index));
    if (match[1]) {
      out += match[2]
        ? '<span class="tok-key">' + esc(match[1]) + '</span><span class="tok-punct">' + esc(match[2]) + '</span>'
        : '<span class="tok-string">' + esc(match[1]) + '</span>';
    } else if (match[3]) out += '<span class="tok-number">' + esc(match[3]) + '</span>';
    else if (match[4]) out += '<span class="tok-bool">' + esc(match[4]) + '</span>';
    else if (match[5]) out += '<span class="tok-null">' + esc(match[5]) + '</span>';
    else if (match[6]) out += '<span class="tok-punct">' + esc(match[6]) + '</span>';
    last = match.index + match[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

function jsonErrorDetail(text) {
  try {
    JSON.parse(text.replace(/^﻿/, ''));
    return null;
  } catch (e) {
    const m = /at position (\d+) \(line (\d+) column (\d+)\)/.exec(e.message) ||
      /at position (\d+)/.exec(e.message);
    const suffix = m
      ? '（第 ' + (m[2] || '?') + ' 行第 ' + (m[3] || '?') + ' 列）'
      : '';
    return e.message + suffix;
  }
}

async function openEditor(app, file) {
  let payload;
  try {
    payload = await api.get('/api/files/' + file.id + '/content');
  } catch (err) {
    toast(err.message, 'err');
    return;
  }

  const isJson = /\.(json)$/i.test(file.name) || /\.(json)$/i.test(file.downloadName || '');
  const original = payload.content;

  const nameInput = el('input', { type: 'text', value: file.name, 'aria-label': '文件名', maxLength: '120' });
  const downloadInput = el('input', {
    type: 'text',
    value: file.downloadName || file.name,
    'aria-label': '下发文件名',
    maxLength: '120'
  });

  const pre = el('pre', { 'aria-hidden': 'true' });
  const code = el('code');
  pre.appendChild(code);
  const textarea = el('textarea', {
    spellcheck: false,
    'aria-label': '文件内容',
    value: original
  });
  const shell = el('div', { class: 'editor-shell' + (isJson ? '' : ' is-plain') }, [pre, textarea]);

  const status = el('div', { class: 'editor-status' });

  function syncHighlight() {
    if (!isJson) return;
    code.innerHTML = highlightJson(textarea.value);
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
  }

  function updateStatus() {
    status.innerHTML = '';
    const chars = textarea.value.length;
    status.appendChild(el('span', { class: 'muted', text: chars + ' 字符 · ' + fmtBytes(new Blob([textarea.value]).size) }));
    if (isJson) {
      const detail = jsonErrorDetail(textarea.value);
      status.appendChild(detail
        ? el('span', { class: 'err', text: '✕ ' + detail })
        : el('span', { class: 'ok', text: '✓ JSON 合法' }));
    }
    if (original.includes('\r\n')) status.appendChild(el('span', { class: 'muted', text: '原始换行 CRLF（保存时保持）' }));
  }

  textarea.addEventListener('input', () => { syncHighlight(); updateStatus(); });
  textarea.addEventListener('scroll', () => { pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft; });
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.slice(0, start) + '  ' + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    syncHighlight();
    updateStatus();
  });

  syncHighlight();
  updateStatus();

  const body = document.createDocumentFragment();
  body.appendChild(el('div', { class: 'editor-meta' }, [
    el('div', { class: 'field' }, [el('label', { text: '文件名' }), nameInput]),
    el('div', { class: 'field' }, [
      el('label', { text: '下发文件名（对外可见）' }),
      downloadInput
    ])
  ]));
  body.appendChild(shell);
  body.appendChild(status);

  const actions = [
    { label: '取消', variant: 'btn-quiet', onClick: () => {} }
  ];

  if (isJson) {
    actions.push({
      label: '格式化',
      variant: 'btn-quiet',
      keepOpen: true,
      onClick: () => {
        const detail = jsonErrorDetail(textarea.value);
        if (detail) { toast('无法格式化：' + detail, 'err'); return; }
        textarea.value = JSON.stringify(JSON.parse(textarea.value.replace(/^﻿/, '')), null, 2);
        syncHighlight();
        updateStatus();
        toast('已格式化', 'ok');
      }
    });
  }

  actions.push({
    label: '另存为新文件',
    variant: 'btn-quiet',
    onClick: async () => {
      if (isJson && jsonErrorDetail(textarea.value)) {
        toast('JSON 格式错误，请修正后再保存', 'err');
        return false;
      }
      try {
        const res = await api.post('/api/files/' + file.id + '/duplicate', {
          content: textarea.value,
          name: nameInput.value.trim() || undefined
        });
        toast('已另存为：' + res.file.name, 'ok');
        renderAppDetail(app.id);
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  actions.push({
    label: '保存并覆盖',
    variant: 'btn btn-pop',
    onClick: async () => {
      if (isJson && jsonErrorDetail(textarea.value)) {
        toast('JSON 格式错误，请修正后再保存', 'err');
        return false;
      }
      const renameTasks = [];
      if (nameInput.value.trim() !== file.name) renameTasks.push({ name: nameInput.value.trim() });
      if (downloadInput.value.trim() !== (file.downloadName || file.name)) {
        renameTasks.push({ downloadName: downloadInput.value.trim() });
      }
      try {
        if (renameTasks.length) {
          await api.patch('/api/files/' + file.id, Object.assign({}, renameTasks[0], renameTasks[1]));
        }
        const res = await api.put('/api/files/' + file.id + '/content', { content: textarea.value });
        toast('已保存：' + res.file.name, 'ok');
        renderAppDetail(app.id);
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  modal.open({
    title: (isJson ? 'JSON 编辑器 · ' : '文本编辑器 · ') + file.name,
    body,
    actions
  });

  setTimeout(() => { textarea.focus(); textarea.setSelectionRange(0, 0); }, 0);
}

/* ============================ 视图：回收站 ============================ */

async function renderTrash() {
  const view = $('#view');
  view.innerHTML = '';

  let res;
  try {
    res = await api.get('/api/trash');
  } catch (err) {
    view.appendChild(el('div', { class: 'empty', text: err.message }));
    return;
  }
  state.trash = res.data;
  const ttlDays = res.data.ttlDays || 7;

  view.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('a', { class: 'crumb', href: '#/apps', text: '← 返回应用列表' }),
      el('h2', { class: 'page-title', text: '回收站' }),
      el('p', {
        class: 'page-sub',
        text: '删除的东西先到这里，' + ttlDays + ' 天后自动永久清理。恢复后回到原应用。'
      })
    ]),
    el('div', { class: 'btn-row' }, [
      (() => {
        const button = el('button', { class: 'btn btn-danger', type: 'button', text: '清空回收站' });
        button.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '清空回收站',
            message: '这将永久删除回收站中的全部文件与应用，不可恢复。确定继续？',
            confirmText: '永久清空',
            danger: true
          });
          if (!ok) return;
          try {
            const cleared = await api.del('/api/trash');
            toast('已清空：' + cleared.cleared.files + ' 个文件 / ' +
              cleared.cleared.applications + ' 个应用', 'ok');
            renderTrash();
          } catch (err) { toast(err.message, 'err'); }
        });
        return button;
      })()
    ])
  ]));

  view.appendChild(renderTrashFiles(state.trash.files, ttlDays));
  view.appendChild(renderTrashApps(state.trash.applications, ttlDays));
}

function renderTrashFiles(files, ttlDays) {
  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'section-title', text: '文件（' + files.length + '）' })
    ])
  ]);

  if (!files.length) {
    panel.appendChild(el('p', { class: 'hint', text: '回收站里没有文件。' }));
    return panel;
  }

  const table = el('table', { class: 'data' });
  const thead = el('thead', {}, [el('tr', {}, [
    el('th', { text: '文件名' }),
    el('th', { text: '原应用' }),
    el('th', { text: '删除时间' }),
    el('th', { text: '自动清理' }),
    el('th', { text: '操作' })
  ])]);
  const tbody = el('tbody');

  files.forEach((item) => {
    const row = el('tr');
    row.appendChild(el('td', { dataset: { label: '文件名' } }, [
      el('div', { class: 'cell-name' }, [
        el('span', { text: item.name }),
        el('span', { class: 'tag tag-deleted', text: '已删除' })
      ])
    ]));
    row.appendChild(el('td', { dataset: { label: '原应用' }, text: item.appName || '—' }));
    row.appendChild(el('td', { dataset: { label: '删除时间' }, text: fmtDate(item.deletedAt) }));
    row.appendChild(el('td', { dataset: { label: '自动清理' }, text: fmtDate(item.purgeAt) + '（' + ttlDays + ' 天后）' }));

    const actions = el('div', { class: 'cell-actions' });
    const restore = el('button', { class: 'btn btn-sm', type: 'button', text: '恢复' });
    restore.addEventListener('click', async () => {
      try {
        const res = await api.post('/api/trash/restore/' + item.fileId);
        toast('已恢复：' + res.file.name, 'ok');
        renderTrash();
      } catch (err) { toast(err.message, 'err'); }
    });
    actions.appendChild(restore);

    const purge = el('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '永久删除' });
    purge.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '永久删除',
        message: '「' + item.name + '」将被永久删除，无法恢复。',
        confirmText: '永久删除',
        danger: true
      });
      if (!ok) return;
      try {
        await api.del('/api/trash/' + item.fileId);
        toast('已永久删除', 'ok');
        renderTrash();
      } catch (err) { toast(err.message, 'err'); }
    });
    actions.appendChild(purge);

    row.appendChild(el('td', { dataset: { label: '操作' } }, [actions]));
    tbody.appendChild(row);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  panel.appendChild(el('div', { class: 'table-wrap' }, [table]));
  return panel;
}

function renderTrashApps(apps, ttlDays) {
  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'section-title', text: '应用（' + apps.length + '）' })
    ])
  ]);

  if (!apps.length) {
    panel.appendChild(el('p', { class: 'hint', text: '回收站里没有应用。' }));
    return panel;
  }

  const table = el('table', { class: 'data' });
  const thead = el('thead', {}, [el('tr', {}, [
    el('th', { text: '应用' }),
    el('th', { text: '文件数' }),
    el('th', { text: '删除时间' }),
    el('th', { text: '自动清理' }),
    el('th', { text: '操作' })
  ])]);
  const tbody = el('tbody');

  apps.forEach((item) => {
    const row = el('tr');
    row.appendChild(el('td', { dataset: { label: '应用' }, text: item.name }));
    row.appendChild(el('td', { dataset: { label: '文件数' }, text: String(item.fileCount || 0) }));
    row.appendChild(el('td', { dataset: { label: '删除时间' }, text: fmtDate(item.deletedAt) }));
    row.appendChild(el('td', { dataset: { label: '自动清理' }, text: fmtDate(item.purgeAt) + '（' + ttlDays + ' 天后）' }));

    const actions = el('div', { class: 'cell-actions' });
    const restore = el('button', { class: 'btn btn-sm', type: 'button', text: '恢复应用' });
    restore.addEventListener('click', async () => {
      try {
        const res = await api.post('/api/trash/apps/restore/' + item.id);
        toast('已恢复「' + res.application.name + '」，含 ' +
          res.application.restoredFiles + ' 个文件', 'ok');
        renderTrash();
      } catch (err) { toast(err.message, 'err'); }
    });
    actions.appendChild(restore);

    const purge = el('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '永久删除' });
    purge.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '永久删除应用',
        message: '应用「' + item.name + '」及其历史记录将被永久删除，无法恢复。',
        confirmText: '永久删除',
        danger: true
      });
      if (!ok) return;
      try {
        await api.del('/api/trash/apps/' + item.id);
        toast('已永久删除', 'ok');
        renderTrash();
      } catch (err) { toast(err.message, 'err'); }
    });
    actions.appendChild(purge);

    row.appendChild(el('td', { dataset: { label: '操作' } }, [actions]));
    tbody.appendChild(row);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  panel.appendChild(el('div', { class: 'table-wrap' }, [table]));
  return panel;
}

/* ============================ 路由 ============================ */

async function refreshTrashBadge() {
  try {
    const res = await api.get('/api/trash');
    const count = (res.data.files || []).length + (res.data.applications || []).length;
    const badge = $('#trashBadge');
    badge.textContent = String(count);
    badge.hidden = count === 0;
  } catch (e) { /* 徽标失败不影响使用 */ }
}

function syncNav(active) {
  $$('.site-nav a').forEach((link) => {
    if (link.dataset.nav === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

async function router() {
  const hash = location.hash || '#/apps';
  if (hash.startsWith('#/apps/')) {
    syncNav('apps');
    await renderAppDetail(hash.slice('#/apps/'.length));
  } else if (hash.startsWith('#/trash')) {
    syncNav('trash');
    await renderTrash();
  } else {
    syncNav('apps');
    await renderApps();
  }
  await refreshTrashBadge();
}

async function boot() {
  modal.init();
  try {
    await refreshLimits();
  } catch (e) { /* 用默认限制继续 */ }
  window.addEventListener('hashchange', router);
  await router();
}

boot().catch((e) => {
  $('#view').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
});
