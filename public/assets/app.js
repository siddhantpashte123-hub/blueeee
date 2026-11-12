'use strict';

/* ============================================================
   BotDeck panel — frontend (no build step, no dependencies)
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const POLL_MS = 3000;
const MAX_DOM_LOGS = 1200;

const state = {
  token: localStorage.getItem('bd_token') || '',
  status: null,
  me: null,
  overview: null,
  bots: [],
  route: { name: '', id: null, tab: null },
  search: '',
  filePath: '',
  stream: null,
  streamBotId: null,
  autoscroll: localStorage.getItem('bd_autoscroll') !== '0',
  pollHandle: null,
  uploadDir: null,
  uploadBotId: null,
  lastRenderedBotId: null,
  lastRenderedTab: null
};

/* ------------------------------ helpers ------------------------------ */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function pct(part, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

function fmtPct(n) {
  const value = Number(n) || 0;
  return value < 10 ? value.toFixed(1) : value.toFixed(0);
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase() || '?';
}

function basename(p) {
  const clean = String(p || '').replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index === -1 ? clean : clean.slice(index + 1);
}

function dirname(p) {
  const clean = String(p || '').replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index === -1 ? '' : clean.slice(0, index);
}

function isActiveStatus(status) {
  return status === 'running' || status === 'starting' || status === 'restarting' || status === 'stopping';
}

const ANSI_COLORS = {
  30: '#6b7a90', 31: '#ff8a8a', 32: '#5ee6a8', 33: '#f7c66b', 34: '#6cb6ff',
  35: '#d18bff', 36: '#56d9e0', 37: '#e2e8f0', 90: '#7c8ba3', 91: '#ff9d9d',
  92: '#8af0c4', 93: '#ffd98a', 94: '#9ccbff', 95: '#e4b3ff', 96: '#8fe8ee', 97: '#ffffff'
};

function ansiToHtml(raw) {
  const text = String(raw == null ? '' : raw)
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0d\x0e-\x1a\x1c-\x1f\x7f]/g, '');
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  let color = null;
  let bold = false;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const segment = esc(parts[i]).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      if (!segment) continue;
      const style = [];
      if (color) style.push(`color:${color}`);
      if (bold) style.push('font-weight:600');
      out += style.length ? `<span style="${style.join(';')}">${segment}</span>` : segment;
    } else {
      for (const code of parts[i].split(';').map(Number)) {
        if (code === 0) { color = null; bold = false; }
        else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code === 39) color = null;
        else if (ANSI_COLORS[code]) color = ANSI_COLORS[code];
      }
    }
  }
  return out;
}

/* ------------------------------- api -------------------------------- */

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);

  let body = options.body;
  const raw = body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer;
  if (body !== undefined && body !== null && !raw && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, { ...options, headers, body });
  } catch (err) {
    const error = new Error('Cannot reach the panel — is the server running?');
    error.network = true;
    throw error;
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }

  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    const error = new Error('Session expired — please sign in again');
    error.isAuth = true;
    handleUnauthorized();
    throw error;
  }
  if (!response.ok) {
    const message = (data && data.error) || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function handleUnauthorized() {
  state.token = '';
  localStorage.removeItem('bd_token');
  state.me = null;
  stopPolling();
  closeStream();
  showAuth(state.status || { setup: false, panelName: 'BotDeck' });
}

/* --------------------------- notifications -------------------------- */

function toast(message, type = 'info', timeout = 4200) {
  const wrap = $('#toast-root');
  if (!wrap) return;
  const el = document.createElement('div');
  const glyph = type === 'success' ? 'check' : type === 'error' ? 'alert' : type === 'warn' ? 'alert' : 'zap';
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(glyph)}<div>${esc(message)}</div>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  }, timeout);
}

/* ------------------------------ modals ------------------------------ */

let modalCleanup = null;

function openModal({ title, subtitle = '', body = '', footer = '', wide = false, onMount, onClose }) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" data-backdrop="1">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h3>${esc(title)}</h3>
            ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
          </div>
          <button class="icon-btn" data-action="close-modal" title="Close">${icon('x')}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  const backdrop = $('.modal-backdrop', root);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeModal();
  });
  modalCleanup = onClose || null;
  const modal = $('.modal', root);
  if (onMount) requestAnimationFrame(() => onMount(modal));
  const focusable = $('input:not([type=hidden]), textarea, select, button.primary', modal);
  if (focusable) requestAnimationFrame(() => focusable.focus());
  return modal;
}

function closeModal() {
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
  if (modalCleanup) {
    try { modalCleanup(); } catch (_) { /* ignore */ }
    modalCleanup = null;
  }
}

function confirmAction({ title, message, confirmText = 'Confirm', danger = true, extra = '', collect }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      let collected;
      try {
        collected = value && collect ? collect() : undefined;
      } catch (_) {
        collected = undefined;
      }
      closeModal();
      resolve(value ? { confirmed: true, extra: collected } : false);
    };
    const modal = openModal({
      title,
      body: `<div style="font-size:13px;color:var(--muted);line-height:1.65">${message}</div>${extra}`,
      footer: `<button class="btn ghost" data-action="close-modal">Cancel</button>
        <div class="right"><button class="btn ${danger ? 'danger' : 'primary'}" id="confirm-yes">${esc(confirmText)}</button></div>`,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }
    });
    const button = $('#confirm-yes', modal);
    button.addEventListener('click', () => finish(true));
  });
}

/* ------------------------------ auth -------------------------------- */

function showAuth(status) {
  state.status = status || state.status;
  stopPolling();
  closeStream();
  $('#app').classList.add('hidden');
  const screen = $('#auth');
  screen.classList.remove('hidden');
  renderAuth(Boolean(state.status && state.status.setup));
}

function renderAuth(setup) {
  const card = $('#auth-card');
  card.innerHTML = `
    <span class="auth-badge">${icon(setup ? 'zap' : 'lock', 'xs')} ${setup ? 'First run setup' : 'Secure panel'}</span>
    <h1>${setup ? 'Create admin password' : 'Welcome back'}</h1>
    <p class="lede">${
      setup
        ? 'Secure your panel with a password. You can create and manage unlimited bots after this.'
        : 'Sign in to manage your bots, logs and files.'
    }</p>
    <div class="auth-error" id="auth-error">${icon('alert', 'sm')}<span id="auth-error-text"></span></div>
    <form id="auth-form" autocomplete="off">
      <div class="stack" style="gap:14px">
        <div class="field">
          <label>Password</label>
          <input class="input" type="password" id="auth-password" autofocus placeholder="${
            setup ? 'At least 8 characters' : 'Enter your password'
          }" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
        </div>
        ${
          setup
            ? `<div class="field">
                 <label>Confirm password</label>
                 <input class="input" type="password" id="auth-confirm" placeholder="Repeat password" required>
               </div>`
            : ''
        }
        <button class="btn primary block" type="submit" id="auth-submit">
          ${setup ? 'Create panel' : 'Sign in'} ${icon('chevron-right', 'sm')}
        </button>
      </div>
    </form>`;

  const form = $('#auth-form', card);
  const errorBox = $('#auth-error', card);
  const submit = $('#auth-submit', card);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.remove('show');
    const password = $('#auth-password', card).value;
    if (setup) {
      const confirm = $('#auth-confirm', card).value;
      if (password.length < 8) return showAuthError('Password must be at least 8 characters');
      if (password !== confirm) return showAuthError('Passwords do not match');
    }
    if (!password) return showAuthError('Password is required');

    submit.disabled = true;
    const original = submit.innerHTML;
    submit.innerHTML = 'Please wait…';
    try {
      const endpoint = setup ? '/api/auth/setup' : '/api/auth/login';
      const data = await api(endpoint, { method: 'POST', body: { password } });
      state.token = data.token;
      localStorage.setItem('bd_token', data.token);
      state.status = { ...(state.status || {}), setup: false, panelName: data.panelName || 'BotDeck' };
      state.me = { authenticated: true };
      await startApp();
    } catch (err) {
      showAuthError(err.message || 'Login failed');
    } finally {
      submit.disabled = false;
      submit.innerHTML = original;
    }
  });

  function showAuthError(message) {
    $('#auth-error-text', card).textContent = message;
    errorBox.classList.add('show');
  }
}

/* ------------------------------ shell ------------------------------- */

function updatePanelName() {
  const name = (state.overview && state.overview.panelName) || (state.me && state.me.panelName) || 'BotDeck';
  const el = $('#panel-name');
  if (el) el.textContent = name;
  document.title = `${name} — Bot Hosting Panel`;
}

function renderShell() {
  $('#sidebar .brand').setAttribute('href', '#/overview');
  const footer = $('#side-footer');
  footer.innerHTML = `
    <div class="meter-block">
      <div class="meter-top"><span>System RAM</span><span id="foot-ram">—</span></div>
      <div class="meter"><i id="foot-ram-bar" style="width:0%"></i></div>
    </div>
    <div class="side-user">
      <span class="avatar">${icon('user', 'sm')}</span>
      <div class="grow">
        <div class="who">Admin</div>
        <div class="role">Panel owner</div>
      </div>
      <button class="icon-btn" data-action="logout" title="Sign out">${icon('logout')}</button>
    </div>`;
}

async function startApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  try {
    state.me = await api('/api/me');
  } catch (err) {
    if (err.isAuth) return;
    toast(err.message, 'error');
    return;
  }
  renderShell();
  await loadOverview();
  updatePanelName();
  if (!location.hash || location.hash === '#') location.hash = '#/overview';
  onRoute();
  startPolling();
}

function startPolling() {
  stopPolling();
  state.pollHandle = setInterval(() => {
    if (document.hidden || !state.me) return;
    loadOverview();
  }, POLL_MS);
}

function stopPolling() {
  if (state.pollHandle) clearInterval(state.pollHandle);
  state.pollHandle = null;
}

/* --------------------------- data loading --------------------------- */

async function loadOverview() {
  try {
    const data = await api('/api/overview');
    state.overview = data;
    state.bots = data.bots || [];
    updatePanelName();
    syncSidebar();
    syncFooter();
    if (state.route.name === 'overview' || state.route.name === 'bots') syncBotsView();
    if (state.route.name === 'bot') {
      const current = botById(state.route.id);
      if (current && state.lastRenderedBotId !== current.id) renderBotView();
      else syncBotLive();
    }
    if (state.route.name === 'settings') syncSettingsStats();
  } catch (err) {
    if (err.isAuth) return;
    if (err.network) setConnectionWarning(true);
  }
}

function setConnectionWarning(offline) {
  const dot = $('#conn-state');
  if (!dot) return;
  dot.textContent = offline ? 'panel offline — retrying' : 'live';
}

function botById(id) {
  return state.bots.find((bot) => bot.id === id) || null;
}

/* --------------------------- sidebar sync --------------------------- */

function syncSidebar() {
  const container = $('#side-bots');
  if (!container) return;

  const countBadge = $('#nav-bot-count');
  if (countBadge) countBadge.textContent = String(state.bots.length);

  const activeId = state.route.name === 'bot' ? state.route.id : null;
  const signature = state.bots.map((bot) => `${bot.id}:${bot.name}:${bot.status}`).join('|') + `#${activeId}`;
  if (container.dataset.sig === signature) return;
  container.dataset.sig = signature;

  if (!state.bots.length) {
    container.innerHTML = `
      <div class="side-empty">
        No bots yet. Create your first bot and BotDeck will keep it running on this VPS.
        <button class="btn sm primary" data-action="new-bot">${icon('plus', 'sm')} Create bot</button>
      </div>`;
    return;
  }

  container.innerHTML = state.bots
    .map(
      (bot) => `
      <a class="side-bot ${bot.id === activeId ? 'active' : ''}" href="#/bot/${bot.id}/console" title="${esc(bot.name)} — ${esc(bot.status)}">
        <span class="status-dot ${esc(bot.status)}"></span>
        <span class="name">${esc(bot.name)}</span>
        ${bot.status === 'running' ? '<span class="status-mini">on</span>' : bot.status === 'crashed' ? '<span class="status-mini" style="color:var(--red)">crash</span>' : ''}
      </a>`
    )
    .join('');
}

function syncFooter() {
  const system = state.overview && state.overview.system;
  if (!system) return;
  const used = system.memory.total - system.memory.free;
  const value = pct(used, system.memory.total);
  const label = $('#foot-ram');
  const bar = $('#foot-ram-bar');
  if (label) label.textContent = `${fmtBytes(used)} / ${fmtBytes(system.memory.total)}`;
  if (bar) {
    bar.style.width = `${value}%`;
    bar.className = value > 90 ? 'crit' : value > 75 ? 'warn' : '';
  }
}

/* ------------------------------ routing ----------------------------- */

function onRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const segments = raw.split('?')[0].split('/').filter(Boolean);
  const previous = state.route;

  closeSidebar();

  const onBotConsole =
    segments[0] === 'bot' && segments[1] && (!segments[2] || segments[2] === 'console');
  if (!onBotConsole) closeStream();
  if (segments[0] !== 'bot') {
    state.lastRenderedBotId = null;
    state.lastRenderedTab = null;
  }

  if (segments[0] === 'bot' && segments[1]) {
    const tab = ['console', 'files', 'settings'].includes(segments[2]) ? segments[2] : 'console';
    if (previous.name !== 'bot' || previous.id !== segments[1]) {
      state.filePath = '';
      state.lastRenderedBotId = null;
      state.lastRenderedTab = null;
    }
    state.route = { name: 'bot', id: segments[1], tab };
    setNav('bots');
    renderBotView();
    return;
  }

  if (segments[0] === 'bots') {
    state.route = { name: 'bots', id: null, tab: null };
    setNav('bots');
    renderBotsView();
    return;
  }

  if (segments[0] === 'settings') {
    state.route = { name: 'settings', id: null, tab: null };
    setNav('settings');
    renderSettingsView();
    return;
  }

  state.route = { name: 'overview', id: null, tab: null };
  setNav('overview');
  renderOverview();
}

function setNav(name) {
  $$('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === name);
  });
}

function navigate(path) {
  if (location.hash === `#${path}`) onRoute();
  else location.hash = `#${path}`;
}

function renderTopbar({ title, subtitle = '', actions = '', back = false }) {
  const topbar = $('#topbar');
  topbar.innerHTML = `
    <button class="icon-btn mobile-menu" data-action="open-sidebar" title="Menu">${icon('menu')}</button>
    ${back ? `<a class="icon-btn" href="#/bots" title="Back to bots">${icon('arrow-left')}</a>` : ''}
    <div class="titles">
      <h1>${esc(title)}</h1>
      ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
    </div>
    <div class="topbar-actions">${actions}</div>`;
}

function closeSidebar() {
  $('#app').classList.remove('sidebar-open');
}

/* ---------------------------- overview ------------------------------ */

function statusPill(status) {
  const label = status === 'running' ? 'Running' : status === 'stopped' ? 'Stopped'
    : status === 'starting' ? 'Starting' : status === 'stopping' ? 'Stopping'
    : status === 'restarting' ? 'Restarting' : status === 'crashed' ? 'Crashed' : status;
  return `<span class="pill ${esc(status)}"><span class="dot"></span>${esc(label)}</span>`;
}

function botRowActions(bot) {
  const running = isActiveStatus(bot.status);
  return `<div class="actions">
    ${
      running
        ? `<button class="icon-btn" data-action="bot-op" data-bot="${bot.id}" data-op="restart" title="Restart">${icon('restart')}</button>
           <button class="icon-btn danger" data-action="bot-op" data-bot="${bot.id}" data-op="stop" title="Stop">${icon('stop')}</button>`
        : `<button class="icon-btn" data-action="bot-op" data-bot="${bot.id}" data-op="start" title="Start">${icon('play')}</button>`
    }
    <button class="icon-btn" data-action="goto-bot" data-bot="${bot.id}" title="Open console">${icon('chevron-right')}</button>
  </div>`;
}

function botRowHtml(bot) {
  const running = isActiveStatus(bot.status);
  return `
    <tr data-action="goto-bot" data-bot="${bot.id}">
      <td>
        <div class="bot-cell">
          <span class="bot-avatar">${esc(initials(bot.name))}</span>
          <div style="min-width:0">
            <div class="bot-name">${esc(bot.name)}</div>
            <div class="bot-meta">${esc(bot.runtime)} · ${esc(bot.entry || '—')}</div>
          </div>
        </div>
      </td>
      <td data-bot-status>${statusPill(bot.status)}</td>
      <td class="num hide-sm" data-bot-cpu>${running ? fmtPct(bot.cpu) + '%' : '—'}</td>
      <td class="num hide-sm" data-bot-mem>${running ? fmtBytes(bot.mem) : '—'}</td>
      <td class="num hide-sm" data-bot-uptime>${running ? fmtDuration(bot.uptime) : '—'}</td>
      <td data-bot-actions>${botRowActions(bot)}</td>
    </tr>`;
}

function botsTableHtml(bots) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr>
      <th>Bot</th><th>Status</th><th class="hide-sm">CPU</th><th class="hide-sm">RAM</th>
      <th class="hide-sm">Uptime</th><th class="right">Actions</th>
    </tr></thead>
    <tbody id="ov-bots-body" data-ids="${bots.map((bot) => bot.id).join(',')}">${bots.map(botRowHtml).join('')}</tbody>
  </table></div>`;
}

function emptyBotsHtml() {
  return `<div class="empty">
    <div class="empty-icon">${icon('box', 'lg')}</div>
    <h3>No bots yet</h3>
    <p>Create a bot and BotDeck runs it directly on this VPS —<br>no Docker, no containers, just processes.</p>
    <button class="btn primary" data-action="new-bot">${icon('plus')} Create your first bot</button>
  </div>`;
}

function renderOverview() {
  const ov = state.overview;
  const system = ov && ov.system;
  const counts = (ov && ov.counts) || { total: 0, running: 0 };

  renderTopbar({
    title: 'Overview',
    subtitle: system
      ? `${esc(system.hostname)} · ${system.cores} vCPU · ${esc(system.cpuModel)}`
      : 'Loading system information…',
    actions: `<button class="btn primary" data-action="new-bot">${icon('plus')} New bot</button>`
  });

  const memPct = system ? pct(system.memory.total - system.memory.free, system.memory.total) : 0;
  const diskPct = system && system.disk ? pct(system.disk.used, system.disk.total) : 0;

  $('#content').innerHTML = `
    <div class="content-inner view-enter">
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-top"><span class="stat-label">Bots</span><span class="stat-icon">${icon('box', 'sm')}</span></div>
          <div class="stat-value"><span id="ov-running">${counts.running}</span><span class="unit">/ ${counts.total} running</span></div>
          <div class="stat-sub" id="ov-bots-sub">${counts.stopped} stopped · ${counts.crashed} crashed</div>
        </div>
        <div class="stat">
          <div class="stat-top"><span class="stat-label">CPU load</span><span class="stat-icon">${icon('cpu', 'sm')}</span></div>
          <div class="stat-value"><span id="ov-cpu">${system ? fmtPct(system.cpu) : '—'}</span><span class="unit">%</span></div>
          <div class="stat-sub" id="ov-load">${system ? `load ${system.load1} · ${system.cores} cores` : '—'}</div>
          <div class="meter"><i id="ov-cpu-bar" style="width:${system ? system.cpu : 0}%"></i></div>
        </div>
        <div class="stat">
          <div class="stat-top"><span class="stat-label">Memory</span><span class="stat-icon">${icon('mem', 'sm')}</span></div>
          <div class="stat-value"><span id="ov-mem">${system ? fmtBytes(system.memory.total - system.memory.free) : '—'}</span></div>
          <div class="stat-sub" id="ov-mem-sub">${system ? `of ${fmtBytes(system.memory.total)} · bots ${fmtBytes(ov.botMemory)}` : '—'}</div>
          <div class="meter"><i id="ov-mem-bar" style="width:${memPct}%" class="${memPct > 90 ? 'crit' : memPct > 75 ? 'warn' : ''}"></i></div>
        </div>
        <div class="stat">
          <div class="stat-top"><span class="stat-label">Disk</span><span class="stat-icon">${icon('disk', 'sm')}</span></div>
          <div class="stat-value"><span id="ov-disk">${system && system.disk ? fmtBytes(system.disk.used) : '—'}</span></div>
          <div class="stat-sub" id="ov-disk-sub">${system && system.disk ? `of ${fmtBytes(system.disk.total)} · ${fmtBytes(system.disk.free)} free` : 'not available'}</div>
          <div class="meter"><i id="ov-disk-bar" style="width:${diskPct}%" class="${diskPct > 90 ? 'crit' : diskPct > 75 ? 'warn' : ''}"></i></div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card">
          <div class="card-head">
            <h3>${icon('activity', 'sm')} Bots</h3>
            <div class="right">
              <button class="btn xs ghost" data-action="bulk" data-op="start-all">${icon('play', 'xs')} Start all</button>
              <button class="btn xs ghost" data-action="bulk" data-op="stop-all">${icon('stop', 'xs')} Stop all</button>
            </div>
          </div>
          <div class="card-body tight">
            <div id="ov-bots-holder">${state.bots.length ? botsTableHtml(state.bots) : emptyBotsHtml()}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>${icon('server', 'sm')} System</h3>
            <div class="right"><span class="chip green" id="conn-chip"><span class="status-dot running" style="width:6px;height:6px"></span> <span id="conn-state">live</span></span></div>
          </div>
          <div class="info-list" id="ov-system-list">
            ${systemInfoHtml(system, ov)}
          </div>
        </div>
      </div>
    </div>`;

  syncBotsView();
}

function systemInfoHtml(system, ov) {
  if (!system) return `<div class="info-row"><span class="k">Loading…</span></div>`;
  const rows = [
    ['server', 'Hostname', system.hostname],
    ['cpu', 'OS', `${system.platform} ${system.release}`],
    ['zap', 'Load (1/5/15)', `${system.load1} / ${system.load5} / ${system.load15}`],
    ['clock', 'Server uptime', fmtDuration(system.uptime * 1000)],
    ['code', 'Node.js', system.nodeVersion],
    ['activity', 'Panel uptime', fmtDuration(system.panel.uptime * 1000)],
    ['folder', 'Bots folder', ov && ov.dirs ? ov.dirs.bots : '—'],
    ['disk', 'Data folder', ov && ov.dirs ? ov.dirs.data : '—']
  ];
  return rows
    .map(
      ([ic, key, value]) => `
      <div class="info-row">
        <span class="k">${icon(ic, 'xs')} ${esc(key)}</span>
        <span class="v mono" title="${esc(value)}">${esc(value)}</span>
      </div>`
    )
    .join('');
}

function syncBotsView() {
  const ov = state.overview;
  if (!ov) return;
  syncSidebar();
  syncFooter();

  if (state.route.name === 'overview') {
    const counts = ov.counts || {};
    const system = ov.system || null;
    const runningEl = $('#ov-running');
    if (runningEl) runningEl.textContent = String(counts.running || 0);
    const sub = $('#ov-bots-sub');
    if (sub) sub.textContent = `${counts.stopped || 0} stopped · ${counts.crashed || 0} crashed`;
    if (system) {
      const memPct = pct(system.memory.total - system.memory.free, system.memory.total);
      const diskPct = system.disk ? pct(system.disk.used, system.disk.total) : 0;
      setText('#ov-cpu', fmtPct(system.cpu));
      setText('#ov-load', `load ${system.load1} · ${system.cores} cores`);
      setWidth('#ov-cpu-bar', system.cpu);
      setText('#ov-mem', fmtBytes(system.memory.total - system.memory.free));
      setText('#ov-mem-sub', `of ${fmtBytes(system.memory.total)} · bots ${fmtBytes(ov.botMemory)}`);
      setWidth('#ov-mem-bar', memPct, memPct > 75);
      setText('#ov-disk', system.disk ? fmtBytes(system.disk.used) : '—');
      setText('#ov-disk-sub', system.disk ? `of ${fmtBytes(system.disk.total)} · ${fmtBytes(system.disk.free)} free` : 'not available');
      setWidth('#ov-disk-bar', diskPct, diskPct > 75);
      const list = $('#ov-system-list');
      if (list) list.innerHTML = systemInfoHtml(system, ov);
    }
    setConnectionWarning(false);

    const holder = $('#ov-bots-holder');
    if (holder) {
      const hasTable = Boolean($('#ov-bots-body', holder));
      if (state.bots.length && !hasTable) holder.innerHTML = botsTableHtml(state.bots);
      else if (!state.bots.length && hasTable) holder.innerHTML = emptyBotsHtml();
      else if (state.bots.length) syncBotTable($('#ov-bots-body', holder), state.bots);
    }
  }

  if (state.route.name === 'bots') {
    renderBotsTable();
  }
}

function setText(selector, text) {
  const el = $(selector);
  if (el && el.textContent !== text) el.textContent = text;
}

function setWidth(selector, value, warn = false) {
  const el = $(selector);
  if (!el) return;
  el.style.width = `${Math.max(0, Math.min(100, value))}%`;
  el.className = warn ? 'warn' : '';
}

function syncBotTable(tbody, bots) {
  if (!tbody) return;
  const ids = bots.map((bot) => bot.id).join(',');
  if (tbody.dataset.ids !== ids) {
    tbody.dataset.ids = ids;
    tbody.innerHTML = bots.map(botRowHtml).join('');
    return;
  }
  for (const bot of bots) {
    const row = tbody.querySelector(`tr[data-bot="${bot.id}"]`);
    if (!row) continue;
    const running = isActiveStatus(bot.status);
    const statusCell = row.querySelector('[data-bot-status]');
    if (statusCell) statusCell.innerHTML = statusPill(bot.status);
    setCell(row, '[data-bot-cpu]', running ? `${fmtPct(bot.cpu)}%` : '—');
    setCell(row, '[data-bot-mem]', running ? fmtBytes(bot.mem) : '—');
    setCell(row, '[data-bot-uptime]', running ? fmtDuration(bot.uptime) : '—');
    const actions = row.querySelector('[data-bot-actions]');
    if (actions && actions.dataset.sig !== bot.status) {
      actions.dataset.sig = bot.status;
      actions.innerHTML = botRowActions(bot);
    }
  }
}

function setCell(row, selector, text) {
  const cell = row.querySelector(selector);
  if (cell && cell.textContent !== text) cell.textContent = text;
}

/* ----------------------------- bots list ---------------------------- */

function renderBotsView() {
  renderTopbar({
    title: 'All bots',
    subtitle: `${state.bots.length} bot${state.bots.length === 1 ? '' : 's'} on this server`,
    actions: `<button class="btn primary" data-action="new-bot">${icon('plus')} New bot</button>`
  });

  $('#content').innerHTML = `
    <div class="content-inner view-enter">
      <div class="row-between" style="margin-bottom:14px;gap:12px;flex-wrap:wrap">
        <div class="search">
          ${icon('search', 'sm')}
          <input class="input" id="bot-search" placeholder="Search bots…" value="${esc(state.search)}">
        </div>
        <div class="row" style="gap:8px">
          <button class="btn sm ghost" data-action="bulk" data-op="start-all">${icon('play', 'sm')} Start all</button>
          <button class="btn sm ghost" data-action="bulk" data-op="stop-all">${icon('stop', 'sm')} Stop all</button>
        </div>
      </div>
      <div class="card">
        <div class="card-body tight" id="all-bots-wrap"></div>
      </div>
    </div>`;

  const search = $('#bot-search');
  if (search) {
    search.addEventListener('input', (event) => {
      state.search = event.target.value;
      renderBotsTable();
    });
  }
  renderBotsTable();
}

function filteredBots() {
  const term = state.search.trim().toLowerCase();
  if (!term) return state.bots;
  return state.bots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(term) ||
      String(bot.runtime).toLowerCase().includes(term) ||
      String(bot.entry || '').toLowerCase().includes(term)
  );
}

function renderBotsTable() {
  const wrap = $('#all-bots-wrap');
  if (!wrap) return;
  const bots = filteredBots();
  if (!state.bots.length) {
    wrap.innerHTML = emptyBotsHtml();
    return;
  }
  if (!bots.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">${icon('search', 'lg')}</div>
      <h3>No matching bots</h3><p>Try a different name or runtime.</p></div>`;
    return;
  }
  const needsTable = !$('#all-bots-body', wrap);
  if (needsTable) {
    wrap.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr>
        <th>Bot</th><th>Status</th><th class="hide-sm">CPU</th><th class="hide-sm">RAM</th>
        <th class="hide-sm">Uptime</th><th class="right">Actions</th>
      </tr></thead>
      <tbody id="all-bots-body"></tbody>
    </table></div>`;
  }
  const tbody = $('#all-bots-body', wrap);
  const ids = bots.map((bot) => bot.id).join(',');
  if (tbody.dataset.ids !== ids) {
    tbody.dataset.ids = ids;
    tbody.innerHTML = bots.map(botRowHtml).join('');
  } else {
    syncBotTable(tbody, bots);
  }
}

/* --------------------------- bot detail ----------------------------- */

function renderBotView() {
  const bot = botById(state.route.id);
  if (!bot) {
    if (!state.overview) {
      $('#content').innerHTML = `<div class="content-inner"><div class="card"><div class="empty">
        <div class="empty-icon">${icon('refresh', 'lg')}</div><h3>Loading bot…</h3></div></div></div>`;
      return;
    }
    renderTopbar({ title: 'Bot not found', subtitle: 'It may have been deleted', back: true });
    $('#content').innerHTML = `<div class="content-inner"><div class="card"><div class="empty">
      <div class="empty-icon">${icon('alert', 'lg')}</div>
      <h3>This bot no longer exists</h3><p>It was deleted from the panel.</p>
      <a class="btn primary" href="#/bots">Back to bots</a></div></div></div>`;
    return;
  }

  renderTopbar({
    title: bot.name,
    subtitle: `${esc(bot.runtime)} · ${esc(bot.entry || '—')}`,
    back: true,
    actions: `<button class="btn sm ghost" data-action="new-bot">${icon('plus', 'sm')} <span class="hide-sm">New bot</span></button>`
  });

  const tab = state.route.tab || 'console';
  if (state.lastRenderedBotId === bot.id && state.lastRenderedTab === tab) {
    syncBotLive();
    return;
  }
  const previousBotId = state.lastRenderedBotId;
  state.lastRenderedBotId = bot.id;
  state.lastRenderedTab = tab;
  if (previousBotId !== bot.id) state.filePath = '';

  const running = isActiveStatus(bot.status);

  $('#content').innerHTML = `
    <div class="content-inner view-enter">
      <div class="bot-hero">
        <span class="bot-avatar">${esc(initials(bot.name))}</span>
        <div class="bot-hero-title">
          <h2>${esc(bot.name)} <span id="bot-status-pill">${statusPill(bot.status)}</span></h2>
          <div class="meta">
            <span class="chip">${icon('code', 'xs')} ${esc(bot.runtime)}</span>
            <span class="dot-sep"></span>
            <span id="bot-meta-pid">${bot.pid ? 'pid ' + bot.pid : 'not running'}</span>
            <span class="dot-sep"></span>
            <span id="bot-meta-uptime">${running ? 'up ' + fmtDuration(bot.uptime) : 'stopped'}</span>
            ${bot.port ? `<span class="dot-sep"></span><a class="chip accent" target="_blank" rel="noopener" href="http://${location.hostname}:${bot.port}">${icon('globe', 'xs')} port ${bot.port}</a>` : ''}
          </div>
        </div>
        <div class="bot-hero-actions" id="bot-actions" data-status="${esc(bot.status)}">${botActionsHtml(bot)}</div>
      </div>

      <div class="tabs">
        <a class="tab ${tab === 'console' ? 'active' : ''}" href="#/bot/${bot.id}/console">${icon('terminal', 'sm')} Console</a>
        <a class="tab ${tab === 'files' ? 'active' : ''}" href="#/bot/${bot.id}/files">${icon('folder', 'sm')} Files</a>
        <a class="tab ${tab === 'settings' ? 'active' : ''}" href="#/bot/${bot.id}/settings">${icon('settings', 'sm')} Settings</a>
      </div>

      <div id="bot-tab-content"></div>
    </div>`;

  const host = $('#bot-tab-content');

  if (tab === 'console') initConsole(bot, host);
  else {
    closeStream();
    if (tab === 'files') initFiles(bot, host);
    else initBotSettings(bot, host);
  }
}

function botActionsHtml(bot) {
  const running = isActiveStatus(bot.status);
  if (!running) {
    return `<button class="btn primary" data-action="bot-op" data-bot="${bot.id}" data-op="start">${icon('play', 'sm')} Start</button>`;
  }
  return `
    <button class="btn ghost" data-action="bot-op" data-bot="${bot.id}" data-op="restart">${icon('restart', 'sm')} Restart</button>
    <button class="btn danger" data-action="bot-op" data-bot="${bot.id}" data-op="stop">${icon('stop', 'sm')} Stop</button>`;
}

function syncBotLive() {
  const bot = botById(state.route.id);
  if (!bot) return;
  const running = isActiveStatus(bot.status);

  const pill = $('#bot-status-pill');
  if (pill) pill.innerHTML = statusPill(bot.status);

  setText('#bot-meta-pid', bot.pid ? `pid ${bot.pid}` : 'not running');
  setText('#bot-meta-uptime', running ? `up ${fmtDuration(bot.uptime)}` : 'stopped');

  const actions = $('#bot-actions');
  if (actions && actions.dataset.status !== bot.status) {
    actions.dataset.status = bot.status;
    actions.innerHTML = botActionsHtml(bot);
  }

  const dot = $('#live-dot');
  if (dot) {
    dot.className = `live-dot ${bot.status === 'running' ? 'on' : bot.status === 'crashed' ? 'err' : ''}`;
  }
  setText('#console-status-text', bot.status === 'running' ? 'live output' : bot.status);
  const pidChip = $('#console-pid');
  if (pidChip) pidChip.textContent = bot.pid ? `pid ${bot.pid}` : 'no pid';
  const input = $('#console-input');
  if (input) input.disabled = bot.status !== 'running';

  setText('#console-cpu', running ? `cpu ${fmtPct(bot.cpu)}%` : 'cpu —');
  setText('#console-mem', running ? `ram ${fmtBytes(bot.mem)}` : 'ram —');
  setText('#files-host-path', bot.dir || '');
}

/* ----------------------------- console ------------------------------ */

function initConsole(bot, host) {
  host.innerHTML = `
    <div class="card console-card">
      <div class="console-bar">
        <div class="console-status">
          <span class="live-dot ${bot.status === 'running' ? 'on' : ''}" id="live-dot"></span>
          <span id="console-status-text">${esc(bot.status === 'running' ? 'live output' : bot.status)}</span>
        </div>
        <span class="chip mono" id="console-pid">${bot.pid ? 'pid ' + bot.pid : 'no pid'}</span>
        <span class="chip mono hide-sm" id="console-cpu">cpu —</span>
        <span class="chip mono hide-sm" id="console-mem">ram —</span>
        <div class="spacer"></div>
        <label class="switch hide-sm" title="Automatically scroll to newest line">
          <input type="checkbox" id="autoscroll-toggle" ${state.autoscroll ? 'checked' : ''}>
          <span class="track"></span>
          <span class="label">Auto-scroll</span>
        </label>
        <button class="btn sm ghost" data-action="download-logs" data-bot="${bot.id}">${icon('download', 'sm')} <span class="hide-sm">Download</span></button>
        <button class="btn sm ghost" data-action="clear-logs" data-bot="${bot.id}">${icon('trash', 'sm')} <span class="hide-sm">Clear</span></button>
      </div>
      <div class="terminal" id="terminal">
        <div class="console-empty">
          ${icon('terminal', 'lg')}
          <div>No output yet.<br><span style="font-size:12px;opacity:.7">Start the bot to see live logs here.</span></div>
        </div>
      </div>
      <form class="console-input" id="console-form" data-bot="${bot.id}">
        <span class="prompt">›</span>
        <input id="console-input" placeholder="Send a line to the bot's stdin…" autocomplete="off" spellcheck="false" ${bot.status === 'running' ? '' : 'disabled'}>
        <button class="btn sm primary" type="submit" ${bot.status === 'running' ? '' : 'disabled'}>Send</button>
      </form>
    </div>
    <div class="hint-box" style="margin-top:12px">
      ${icon('terminal', 'sm')}
      <div>Live console streams straight from the bot process. Logs are also written to <span class="mono">data/logs/${esc(bot.id)}.log</span> on the server.</div>
    </div>`;

  const toggle = $('#autoscroll-toggle');
  if (toggle) {
    toggle.addEventListener('change', () => {
      state.autoscroll = toggle.checked;
      localStorage.setItem('bd_autoscroll', state.autoscroll ? '1' : '0');
      if (state.autoscroll) scrollTerminal();
    });
  }

  loadLogs(bot.id).then(() => openStream(bot.id));
}

async function loadLogs(botId) {
  const term = $('#terminal');
  if (!term) return;
  try {
    const data = await api(`/api/bots/${botId}/logs?lines=400`);
    if (!data || !data.logs) return;
    const current = $('#terminal');
    if (!current) return;
    current.innerHTML = '';
    for (const entry of data.logs) appendLog(entry, false);
    if (!data.logs.length) showConsoleEmpty();
    scrollTerminal();
  } catch (err) {
    if (!err.isAuth) console.warn(err);
  }
}

function showConsoleEmpty() {
  const term = $('#terminal');
  if (!term || term.children.length) return;
  term.innerHTML = `<div class="console-empty">${icon('terminal', 'lg')}
    <div>No output yet.<br><span style="font-size:12px;opacity:.7">Start the bot to see live logs here.</span></div></div>`;
}

function appendLog(entry, autoscroll = true) {
  const term = $('#terminal');
  if (!term) return;
  const empty = $('.console-empty', term);
  if (empty) empty.remove();

  const line = document.createElement('div');
  const kind = entry.s === 'err' ? 'err' : entry.s === 'sys' ? 'sys' : 'out';
  line.className = `log-line ${kind}`;
  const time = entry.t ? `<span class="ts">${new Date(entry.t).toLocaleTimeString('en-GB')}</span>` : '';
  line.innerHTML = time + ansiToHtml(entry.m == null ? '' : entry.m);
  term.appendChild(line);

  while (term.children.length > MAX_DOM_LOGS) term.removeChild(term.firstChild);
  if (autoscroll && state.autoscroll) scrollTerminal();
}

function scrollTerminal() {
  const term = $('#terminal');
  if (term) term.scrollTop = term.scrollHeight;
}

function openStream(botId) {
  closeStream();
  if (!state.token) return;
  const source = new EventSource(`/api/bots/${botId}/stream?token=${encodeURIComponent(state.token)}`);
  state.stream = source;
  state.streamBotId = botId;

  source.addEventListener('open', () => {
    const dot = $('#live-dot');
    const bot = botById(botId);
    if (dot && bot && bot.status === 'running') dot.className = 'live-dot on';
  });

  source.addEventListener('log', (event) => {
    try {
      appendLog(JSON.parse(event.data));
    } catch (_) { /* ignore */ }
  });

  source.addEventListener('status', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleStatusEvent(botId, payload);
    } catch (_) { /* ignore */ }
  });

  source.addEventListener('error', () => {
    const dot = $('#live-dot');
    if (dot) dot.className = 'live-dot err';
  });
}

function handleStatusEvent(botId, payload) {
  const dot = $('#live-dot');
  if (dot) dot.className = `live-dot ${payload.status === 'running' ? 'on' : payload.status === 'crashed' ? 'err' : ''}`;

  const bot = botById(botId);
  if (bot) {
    if (payload.pid !== undefined) bot.pid = payload.pid;
    bot.status = payload.status;
    syncBotLive();
    syncSidebar();
  }
  setText('#console-status-text', payload.status);
  const input = $('#console-input');
  if (input) input.disabled = payload.status !== 'running';
  const sendButton = $('#console-form button[type=submit]');
  if (sendButton) sendButton.disabled = payload.status !== 'running';

  const pill = $('#bot-status-pill');
  if (pill) pill.innerHTML = statusPill(payload.status);
}

function closeStream() {
  if (state.stream) {
    try { state.stream.close(); } catch (_) { /* ignore */ }
  }
  state.stream = null;
  state.streamBotId = null;
}

/* ------------------------------ files ------------------------------- */

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.sh', '.bash', '.json', '.yml', '.yaml',
  '.toml', '.ini', '.conf', '.env', '.txt', '.md', '.html', '.css', '.java', '.go', '.rs', '.rb',
  '.php', '.c', '.h', '.cpp', '.cs', '.sql', '.xml', '.lua', '.pl'
]);
const ARCHIVE_EXT = ['.zip', '.tar', '.tar.gz', '.tgz'];

function fileKind(name, type) {
  if (type === 'dir') return 'dir';
  const lower = name.toLowerCase();
  if (ARCHIVE_EXT.some((ext) => lower.endsWith(ext))) return 'archive';
  const ext = lower.slice(lower.lastIndexOf('.'));
  const base = lower.startsWith('.') ? lower : name.toLowerCase();
  if (base === '.env' || CODE_EXT.has(ext)) return 'code';
  return 'file';
}

function initFiles(bot, host) {
  host.innerHTML = `
    <div class="card">
      <div class="files-toolbar">
        <div class="crumbs" id="crumbs"></div>
        <div class="spacer"></div>
        <button class="btn sm ghost" data-action="files-refresh" data-bot="${bot.id}" title="Refresh">${icon('refresh', 'sm')}</button>
        <button class="btn sm ghost" data-action="files-new-folder" data-bot="${bot.id}">${icon('folder-plus', 'sm')} <span class="hide-sm">Folder</span></button>
        <button class="btn sm ghost" data-action="files-new-file" data-bot="${bot.id}">${icon('file-plus', 'sm')} <span class="hide-sm">File</span></button>
        <button class="btn sm primary" data-action="files-upload" data-bot="${bot.id}">${icon('upload', 'sm')} Upload</button>
      </div>
      <div class="card-body tight files-drop" id="files-drop">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Name</th><th class="hide-sm">Size</th><th class="hide-sm">Modified</th><th class="right">Actions</th></tr></thead>
            <tbody id="files-body">
              <tr><td colspan="4"><div class="empty" style="padding:28px">Loading files…</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="console-bar" style="border-top:1px solid var(--border-soft);border-bottom:none">
        <span class="muted small">${icon('folder', 'xs')} <span class="mono" id="files-host-path">${esc(bot.dir || '')}</span></span>
      </div>
    </div>
    <div class="hint-box" style="margin-top:12px">
      ${icon('upload', 'sm')}
      <div>Drag &amp; drop files anywhere on this panel to upload. Archives (.zip, .tar.gz) can be extracted with the archive button.</div>
    </div>`;

  const drop = $('#files-drop');
  if (drop) {
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('dragover');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('dragover');
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length) uploadFiles(bot.id, state.filePath, files);
    });
  }

  loadFiles(bot.id, state.filePath);
}

async function loadFiles(botId, path = '') {
  state.filePath = String(path || '').replace(/^\/+/, '');
  renderCrumbs();
  const tbody = $('#files-body');
  if (!tbody) return;
  try {
    const data = await api(`/api/bots/${botId}/files?path=${encodeURIComponent(state.filePath)}`);
    renderFileRows(data.items || []);
  } catch (err) {
    if (err.isAuth) return;
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty">
      <div class="empty-icon">${icon('alert', 'lg')}</div><h3>Could not load files</h3><p>${esc(err.message)}</p></div></td></tr>`;
  }
}

function renderCrumbs() {
  const container = $('#crumbs');
  if (!container) return;
  const parts = state.filePath.split('/').filter(Boolean);
  let accumulated = '';
  const botId = state.route.id;
  const items = [
    `<span class="crumb ${parts.length ? '' : 'current'}" data-action="files-open-dir" data-bot="${botId}" data-path="">${icon('folder', 'sm')} bot</span>`
  ];
  for (let i = 0; i < parts.length; i++) {
    accumulated = accumulated ? `${accumulated}/${parts[i]}` : parts[i];
    const current = i === parts.length - 1;
    items.push('<span class="crumb-sep">/</span>');
    items.push(
      `<span class="crumb ${current ? 'current' : ''}" data-action="files-open-dir" data-bot="${botId}" data-path="${esc(accumulated)}">${esc(parts[i])}</span>`
    );
  }
  container.innerHTML = items.join('');
}

function renderFileRows(items) {
  const tbody = $('#files-body');
  if (!tbody) return;

  const rows = [];
  if (state.filePath) {
    const parent = dirname(state.filePath);
    rows.push(`
      <tr data-action="files-open-dir" data-bot="${state.route.id}" data-path="${esc(parent)}">
        <td><div class="file-row"><span class="file-icon dir">${icon('arrow-left', 'sm')}</span>
          <div><div class="bot-name">..</div><div class="bot-meta">parent folder</div></div></div></td>
        <td class="hide-sm">—</td><td class="hide-sm">—</td><td></td>
      </tr>`);
  }

  for (const item of items) {
    const kind = fileKind(item.name, item.type);
    const isArchive = kind === 'archive';
    rows.push(`
      <tr>
        <td>
          <div class="file-row">
            <span class="file-icon ${kind}">${icon(item.type === 'dir' ? 'folder' : isArchive ? 'box' : 'file', 'sm')}</span>
            <div style="min-width:0">
              <div class="bot-name">${
                item.type === 'dir'
                  ? `<span style="cursor:pointer" data-action="files-open-dir" data-bot="${state.route.id}" data-path="${esc(item.path)}">${esc(item.name)}</span>`
                  : `<span style="cursor:pointer" data-action="files-edit" data-bot="${state.route.id}" data-path="${esc(item.path)}">${esc(item.name)}</span>`
              }</div>
              <div class="bot-meta">${item.type === 'dir' ? 'folder' : esc(item.type)}</div>
            </div>
          </div>
        </td>
        <td class="num hide-sm" style="cursor:default">${item.type === 'dir' ? '—' : fmtBytes(item.size)}</td>
        <td class="muted small hide-sm">${item.mtime ? new Date(item.mtime).toLocaleString() : '—'}</td>
        <td>
          <div class="actions">
            ${isArchive ? `<button class="icon-btn" data-action="files-extract" data-bot="${state.route.id}" data-path="${esc(item.path)}" title="Extract here">${icon('box')}</button>` : ''}
            ${item.type === 'file' ? `<button class="icon-btn" data-action="files-edit" data-bot="${state.route.id}" data-path="${esc(item.path)}" title="Edit">${icon('edit')}</button>
            <button class="icon-btn" data-action="files-download" data-bot="${state.route.id}" data-path="${esc(item.path)}" title="Download">${icon('download')}</button>` : ''}
            <button class="icon-btn" data-action="files-rename" data-bot="${state.route.id}" data-path="${esc(item.path)}" title="Rename">${icon('text')}</button>
            <button class="icon-btn danger" data-action="files-delete" data-bot="${state.route.id}" data-path="${esc(item.path)}" title="Delete">${icon('trash')}</button>
          </div>
        </td>
      </tr>`);
  }

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty">
      <div class="empty-icon">${icon('folder', 'lg')}</div>
      <h3>This folder is empty</h3><p>Upload your bot files or create a new file to get started.</p>
      <button class="btn primary" data-action="files-upload" data-bot="${state.route.id}">${icon('upload')} Upload files</button>
    </div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.join('');
}

async function uploadFiles(botId, dir, files) {
  if (!files || !files.length) return;
  let uploaded = 0;
  for (const file of files) {
    try {
      const url = `/api/bots/${botId}/files/upload?path=${encodeURIComponent(dir || '')}&name=${encodeURIComponent(file.name)}`;
      await api(url, { method: 'PUT', body: file });
      uploaded++;
    } catch (err) {
      if (err.isAuth) return;
      toast(`Upload failed for ${file.name}: ${err.message}`, 'error');
    }
  }
  if (uploaded) toast(`${uploaded} file${uploaded === 1 ? '' : 's'} uploaded`, 'success');
  loadFiles(botId, dir);
}

async function openEditor(botId, filePath) {
  let data;
  try {
    data = await api(`/api/bots/${botId}/files/read?path=${encodeURIComponent(filePath)}`);
  } catch (err) {
    if (err.isAuth) return;
    toast(err.message, 'error');
    return;
  }

  const modal = openModal({
    title: basename(filePath),
    subtitle: `${fmtBytes(data.size)} · ${esc(filePath)}`,
    wide: true,
    body: `
      <div class="editor-meta">
        <span class="chip">UTF-8</span>
        <span class="chip">${icon('edit', 'xs')} editing</span>
        <span class="spacer grow"></span>
        <span><span class="kbd">Ctrl</span> + <span class="kbd">S</span> to save</span>
      </div>
      <textarea class="editor-area mono" id="editor-area" spellcheck="false"></textarea>`,
    footer: `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <div class="right"><button class="btn primary" id="editor-save">${icon('save', 'sm')} Save file</button></div>`
  });

  const area = $('#editor-area', modal);
  area.value = data.content;

  const save = async () => {
    const button = $('#editor-save', modal);
    if (button) button.disabled = true;
    try {
      await api(`/api/bots/${botId}/files/write?path=${encodeURIComponent(filePath)}`, {
        method: 'PUT',
        body: { content: area.value }
      });
      toast('File saved', 'success');
      closeModal();
      loadFiles(botId, state.filePath);
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
      if (button) button.disabled = false;
    }
  };

  $('#editor-save', modal).addEventListener('click', save);
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = area.selectionStart;
      const end = area.selectionEnd;
      area.value = area.value.slice(0, start) + '  ' + area.value.slice(end);
      area.selectionStart = area.selectionEnd = start + 2;
    }
  });
}

function newFileDialog(botId) {
  const modal = openModal({
    title: 'New file',
    subtitle: state.filePath ? `in /${state.filePath}` : 'in bot root',
    body: `<div class="field"><label>File name</label>
      <input class="input mono" id="new-file-name" placeholder="index.js" autocomplete="off"></div>
      <div class="hint" style="margin-top:8px">Nested paths are allowed, e.g. <span class="mono">src/main.py</span>.</div>`,
    footer: `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <div class="right"><button class="btn primary" id="new-file-create">${icon('plus', 'sm')} Create</button></div>`
  });

  const input = $('#new-file-name', modal);
  const create = async () => {
    const name = input.value.trim();
    if (!name) return toast('Enter a file name', 'error');
    const full = state.filePath ? `${state.filePath}/${name}` : name;
    try {
      await api(`/api/bots/${botId}/files/write?path=${encodeURIComponent(full)}`, {
        method: 'PUT',
        body: { content: '' }
      });
      closeModal();
      toast('File created', 'success');
      await loadFiles(botId, state.filePath);
      openEditor(botId, full);
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
    }
  };
  $('#new-file-create', modal).addEventListener('click', create);
  input.addEventListener('keydown', (event) => event.key === 'Enter' && create());
}

function newFolderDialog(botId) {
  const modal = openModal({
    title: 'New folder',
    subtitle: state.filePath ? `in /${state.filePath}` : 'in bot root',
    body: `<div class="field"><label>Folder name</label>
      <input class="input mono" id="new-folder-name" placeholder="data" autocomplete="off"></div>`,
    footer: `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <div class="right"><button class="btn primary" id="new-folder-create">${icon('plus', 'sm')} Create</button></div>`
  });
  const input = $('#new-folder-name', modal);
  const create = async () => {
    const name = input.value.trim();
    if (!name) return toast('Enter a folder name', 'error');
    try {
      await api(`/api/bots/${botId}/files/mkdir`, {
        method: 'POST',
        body: { path: state.filePath ? `${state.filePath}/${name}` : name }
      });
      closeModal();
      toast('Folder created', 'success');
      loadFiles(botId, state.filePath);
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
    }
  };
  $('#new-folder-create', modal).addEventListener('click', create);
  input.addEventListener('keydown', (event) => event.key === 'Enter' && create());
}

function renameDialog(botId, filePath) {
  const modal = openModal({
    title: 'Rename',
    subtitle: filePath,
    body: `<div class="field"><label>New name</label>
      <input class="input mono" id="rename-input" value="${esc(basename(filePath))}" autocomplete="off"></div>`,
    footer: `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <div class="right"><button class="btn primary" id="rename-save">${icon('save', 'sm')} Rename</button></div>`
  });
  const input = $('#rename-input', modal);
  input.select();
  const save = async () => {
    const name = input.value.trim();
    if (!name) return toast('Enter a name', 'error');
    const target = dirname(filePath) ? `${dirname(filePath)}/${name}` : name;
    try {
      await api(`/api/bots/${botId}/files/rename`, { method: 'POST', body: { from: filePath, to: target } });
      closeModal();
      toast('Renamed', 'success');
      loadFiles(botId, state.filePath);
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
    }
  };
  $('#rename-save', modal).addEventListener('click', save);
  input.addEventListener('keydown', (event) => event.key === 'Enter' && save());
}

async function deleteFileDialog(botId, filePath) {
  const confirmed = await confirmAction({
    title: 'Delete file',
    message: `Delete <strong class="mono">${esc(filePath)}</strong>? This cannot be undone.`,
    confirmText: 'Delete'
  });
  if (!confirmed) return;
  try {
    await api(`/api/bots/${botId}/files/delete`, { method: 'POST', body: { path: filePath } });
    toast('Deleted', 'success');
    loadFiles(botId, state.filePath);
  } catch (err) {
    if (!err.isAuth) toast(err.message, 'error');
  }
}

async function extractDialog(botId, filePath) {
  const confirmed = await confirmAction({
    title: 'Extract archive',
    message: `Extract <strong class="mono">${esc(filePath)}</strong> into <span class="mono">/${esc(dirname(filePath) || '')}</span>? Existing files may be overwritten.`,
    confirmText: 'Extract',
    danger: false
  });
  if (!confirmed) return;
  try {
    const result = await api(`/api/bots/${botId}/files/extract`, { method: 'POST', body: { path: filePath } });
    toast(`Extracted ${result.files} entries`, 'success');
    loadFiles(botId, dirname(filePath));
  } catch (err) {
    if (!err.isAuth) toast(err.message, 'error');
  }
}

async function downloadFile(botId, filePath) {
  try {
    const response = await fetch(
      `/api/bots/${botId}/files/download?path=${encodeURIComponent(filePath)}`,
      { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} }
    );
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = basename(filePath);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function downloadLogs(botId, botName) {
  try {
    const response = await fetch(`/api/bots/${botId}/logs/download`, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
    });
    if (!response.ok) throw new Error(response.status === 404 ? 'No logs yet' : `Download failed (${response.status})`);
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${String(botName || 'bot').replace(/[^A-Za-z0-9._-]+/g, '_')}.log`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* --------------------------- bot settings --------------------------- */

function initBotSettings(bot, host) {
  const envRows = Object.entries(bot.env || {})
    .map(
      ([key, value]) => `
      <div class="env-row" data-env-row>
        <input class="input mono" data-env-key placeholder="KEY" value="${esc(key)}" spellcheck="false">
        <input class="input mono env-value" data-env-val placeholder="value" value="${esc(value)}" spellcheck="false">
        <button class="icon-btn danger" type="button" data-action="remove-env" title="Remove">${icon('x', 'sm')}</button>
      </div>`
    )
    .join('');

  host.innerHTML = `
    <div class="stack">
      <div class="card">
        <div class="card-head"><h3>${icon('settings', 'sm')} Bot configuration</h3>
          <div class="right">
            <span class="chip hide-sm">id ${esc(bot.id)}</span>
            <button class="btn xs ghost" data-action="clone-bot" data-bot="${bot.id}">${icon('copy', 'xs')} Clone</button>
          </div>
        </div>
        <div class="card-body">
          <div class="form-grid">
            <div class="field">
              <label>Bot name</label>
              <input class="input" id="f-name" value="${esc(bot.name)}" maxlength="40">
            </div>
            <div class="field">
              <label>Runtime</label>
              <select class="select" id="f-runtime">
                ${['node', 'python', 'bash', 'custom']
                  .map((rt) => `<option value="${rt}" ${bot.runtime === rt ? 'selected' : ''}>${runtimeLabel(rt)}</option>`)
                  .join('')}
              </select>
              <div class="hint">Node.js · Python · Bash · Custom shell command</div>
            </div>
            <div class="field">
              <label>Entry file / command</label>
              <input class="input mono" id="f-entry" value="${esc(bot.entry || '')}" spellcheck="false">
              <div class="hint" id="f-entry-hint">${bot.runtime === 'custom' ? 'Runs through /bin/sh — e.g. <span class="mono">bash start.sh</span>' : 'Relative to the bot folder'}</div>
            </div>
            <div class="field">
              <label>Arguments <span class="hint">optional</span></label>
              <input class="input mono" id="f-args" value="${esc(bot.args || '')}" placeholder="--flag value" spellcheck="false">
            </div>
            <div class="field">
              <label>Port <span class="hint">optional</span></label>
              <input class="input mono" id="f-port" type="number" min="1" max="65535" value="${bot.port || ''}" placeholder="3001">
              <div class="hint">Injected as <span class="mono">PORT</span> env variable</div>
            </div>
            <div class="field">
              <label>Memory limit (MB)</label>
              <input class="input mono" id="f-memlimit" type="number" min="0" max="65536" value="${bot.memoryLimitMB || 0}">
              <div class="hint">0 = unlimited. Bot is stopped if it goes above this.</div>
            </div>
            <div class="field full">
              <label>Description <span class="hint">optional</span></label>
              <input class="input" id="f-description" value="${esc(bot.description || '')}" placeholder="What does this bot do?" maxlength="300">
            </div>
          </div>

          <div class="divider"></div>

          <div class="row" style="gap:26px;flex-wrap:wrap">
            <label class="switch">
              <input type="checkbox" id="f-autostart" ${bot.autostart ? 'checked' : ''}>
              <span class="track"></span>
              <span class="label">Start with panel</span>
            </label>
            <label class="switch">
              <input type="checkbox" id="f-autorestart" ${bot.autoRestart ? 'checked' : ''}>
              <span class="track"></span>
              <span class="label">Auto-restart on crash</span>
            </label>
            <div class="row" style="gap:8px">
              <span class="muted small">Max restart attempts</span>
              <input class="input mono" id="f-maxrestarts" type="number" min="0" max="1000" value="${bot.maxRestarts ?? 10}" style="width:84px;height:32px">
            </div>
          </div>

          <div class="divider"></div>

          <div class="field">
            <label>Environment variables</label>
            <div class="stack" id="env-rows" style="gap:8px">
              ${envRows || '<div class="env-empty" id="env-empty">No variables yet.</div>'}
            </div>
            <div style="margin-top:10px">
              <button class="btn sm ghost" type="button" data-action="add-env">${icon('plus', 'sm')} Add variable</button>
            </div>
          </div>

          <div class="divider"></div>

          <div class="row-between" style="flex-wrap:wrap;gap:12px">
            <div class="muted small">Last exit:
              ${
                bot.lastExit
                  ? `<span class="mono">${esc(bot.lastExit.reason || 'exit ' + bot.lastExit.code)}</span> · ${new Date(bot.lastExit.at).toLocaleString()}`
                  : 'never'
              }
            </div>
            <button class="btn primary" data-action="save-bot" data-bot="${bot.id}">${icon('save', 'sm')} Save changes</button>
          </div>
        </div>
      </div>

      <div class="card danger-zone">
        <div class="card-head"><h3>${icon('alert', 'sm')} Danger zone</h3></div>
        <div class="card-body">
          <div class="row-between" style="flex-wrap:wrap;gap:14px">
            <div>
              <div style="font-weight:600;font-size:13px">Delete this bot</div>
              <div class="muted small" style="margin-top:2px">Stops the process and removes it from the panel.</div>
            </div>
            <div class="row" style="gap:8px">
              <button class="btn sm ghost" data-action="bot-op" data-bot="${bot.id}" data-op="kill">${icon('power', 'sm')} Force kill</button>
              <button class="btn sm danger" data-action="delete-bot" data-bot="${bot.id}">${icon('trash', 'sm')} Delete bot</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  bindRuntimeDefaults();
}

/** When the runtime changes, swap a default-looking entry file automatically. */
function bindRuntimeDefaults() {
  const select = $('#f-runtime');
  const entry = $('#f-entry');
  const hint = $('#f-entry-hint');
  if (!select || !entry) return;

  const defaults = { node: 'index.js', python: 'main.py', bash: 'start.sh', custom: 'bash start.sh' };
  const hints = {
    node: 'Relative to the bot folder',
    python: 'Relative to the bot folder',
    bash: 'Relative to the bot folder',
    custom: 'Runs through /bin/sh — e.g. <span class="mono">bash start.sh</span>'
  };
  let previous = select.value;

  select.addEventListener('change', () => {
    const next = select.value;
    const current = entry.value.trim();
    if (!current || current === defaults[previous]) entry.value = defaults[next];
    if (hint) hint.innerHTML = hints[next] || '';
    previous = next;
  });
}

function runtimeLabel(runtime) {
  return runtime === 'node' ? 'Node.js' : runtime === 'python' ? 'Python' : runtime === 'bash' ? 'Bash script' : 'Custom command';
}

function addEnvRow() {
  const container = $('#env-rows');
  if (!container) return;
  const empty = $('#env-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'env-row';
  row.setAttribute('data-env-row', '');
  row.innerHTML = `
    <input class="input mono" data-env-key placeholder="KEY" spellcheck="false">
    <input class="input mono env-value" data-env-val placeholder="value" spellcheck="false">
    <button class="icon-btn danger" type="button" data-action="remove-env" title="Remove">${icon('x', 'sm')}</button>`;
  container.appendChild(row);
  row.querySelector('[data-env-key]').focus();
}

async function saveBotSettings(botId) {
  const env = {};
  $$('#env-rows [data-env-row]').forEach((row) => {
    const key = row.querySelector('[data-env-key]').value.trim();
    const value = row.querySelector('[data-env-val]').value;
    if (key) env[key] = value;
  });

  const payload = {
    name: $('#f-name').value.trim(),
    runtime: $('#f-runtime').value,
    entry: $('#f-entry').value.trim(),
    args: $('#f-args').value,
    description: $('#f-description').value,
    port: $('#f-port').value ? Number($('#f-port').value) : null,
    memoryLimitMB: Number($('#f-memlimit').value) || 0,
    maxRestarts: Number($('#f-maxrestarts').value) || 0,
    autoRestart: $('#f-autorestart').checked,
    autostart: $('#f-autostart').checked,
    env
  };

  const button = $('[data-action="save-bot"]');
  if (button) button.disabled = true;
  try {
    await api(`/api/bots/${botId}`, { method: 'PATCH', body: payload });
    toast('Bot settings saved', 'success');
    await loadOverview();
    const bot = botById(botId);
    if (bot) {
      renderTopbar({
        title: bot.name,
        subtitle: `${esc(bot.runtime)} · ${esc(bot.entry || '—')}`,
        back: true,
        actions: `<button class="btn sm ghost" data-action="new-bot">${icon('plus', 'sm')} <span class="hide-sm">New bot</span></button>`
      });
      syncBotLive();
    }
  } catch (err) {
    if (!err.isAuth) toast(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function deleteBotDialog(botId) {
  const bot = botById(botId);
  if (!bot) return;
  const confirmed = await confirmAction({
    title: 'Delete bot',
    message: `Permanently delete <strong>${esc(bot.name)}</strong>? The bot will be stopped and removed from the panel.`,
    confirmText: 'Delete bot',
    collect: () => Boolean($('#delete-files') && $('#delete-files').checked),
    extra: `<label class="switch" style="margin-top:16px">
        <input type="checkbox" id="delete-files">
        <span class="track"></span>
        <span class="label">Also delete all files in the bot folder</span>
      </label>`
  });
  if (!confirmed) return;
  const deleteFiles = Boolean(confirmed.extra);
  try {
    await api(`/api/bots/${botId}?files=${deleteFiles ? '1' : '0'}`, { method: 'DELETE' });
    toast('Bot deleted', 'success');
    if (state.route.name === 'bot' && state.route.id === botId) navigate('/bots');
    await loadOverview();
  } catch (err) {
    if (!err.isAuth) toast(err.message, 'error');
  }
}

/* --------------------------- clone bot ------------------------------ */

function cloneBotDialog(botId) {
  const bot = botById(botId);
  if (!bot) return;
  const modal = openModal({
    title: 'Clone bot',
    subtitle: 'Copies the whole bot folder and its settings',
    body: `<div class="field">
        <label>Name for the copy</label>
        <input class="input" id="clone-name" value="${esc(bot.name + ' copy')}" maxlength="40">
        <div class="hint">Files, environment variables and runtime settings are copied. The clone starts stopped.</div>
      </div>`,
    footer: `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <div class="right"><button class="btn primary" id="clone-create">${icon('copy', 'sm')} Clone bot</button></div>`
  });

  const input = $('#clone-name', modal);
  input.select();

  const create = async () => {
    const name = input.value.trim();
    if (!name) return toast('Enter a name', 'error');
    const button = $('#clone-create', modal);
    button.disabled = true;
    button.innerHTML = 'Cloning…';
    try {
      const data = await api(`/api/bots/${botId}/clone`, { method: 'POST', body: { name } });
      closeModal();
      toast(`Cloned to "${name}"`, 'success');
      await loadOverview();
      navigate(`/bot/${data.bot.id}/settings`);
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
      button.disabled = false;
      button.innerHTML = `${icon('copy', 'sm')} Clone bot`;
    }
  };

  $('#clone-create', modal).addEventListener('click', create);
  input.addEventListener('keydown', (event) => event.key === 'Enter' && create());
}

/* --------------------------- new bot modal -------------------------- */

function newBotDialog() {
  const modal = openModal({
    title: 'Create a bot',
    subtitle: 'Runs as a normal process on this VPS — no Docker needed',
    body: `
      <div class="stack" style="gap:16px">
        <div class="field">
          <label>Bot name</label>
          <input class="input" id="nb-name" placeholder="Minecraft bot" maxlength="40" autocomplete="off">
        </div>
        <div class="field">
          <label>Runtime</label>
          <select class="select" id="nb-runtime">
            <option value="node">Node.js</option>
            <option value="python">Python 3</option>
            <option value="bash">Bash script</option>
            <option value="custom">Custom command</option>
          </select>
          <div class="hint" id="nb-runtime-hint">Runs <span class="mono">node index.js</span> inside the bot folder.</div>
        </div>
        <div class="row" style="gap:24px;flex-wrap:wrap">
          <label class="switch">
            <input type="checkbox" id="nb-start" checked>
            <span class="track"></span><span class="label">Start immediately</span>
          </label>
          <label class="switch">
            <input type="checkbox" id="nb-autostart">
            <span class="track"></span><span class="label">Start with panel</span>
          </label>
        </div>
      </div>`,
    footer: `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <div class="right"><button class="btn primary" id="nb-create">${icon('plus', 'sm')} Create bot</button></div>`
  });

  const hints = {
    node: 'Runs <span class="mono">node index.js</span> inside the bot folder.',
    python: 'Runs <span class="mono">python3 -u main.py</span> inside the bot folder.',
    bash: 'Runs <span class="mono">bash start.sh</span> inside the bot folder.',
    custom: 'Your command runs through <span class="mono">/bin/sh</span>.'
  };

  const runtime = $('#nb-runtime', modal);
  runtime.addEventListener('change', () => {
    $('#nb-runtime-hint', modal).innerHTML = hints[runtime.value];
  });
  runtime.dispatchEvent(new Event('change'));

  const create = async () => {
    const name = $('#nb-name', modal).value.trim();
    if (!name) {
      toast('Enter a bot name', 'error');
      $('#nb-name', modal).focus();
      return;
    }
    const button = $('#nb-create', modal);
    button.disabled = true;
    button.innerHTML = 'Creating…';
    try {
      const data = await api('/api/bots', {
        method: 'POST',
        body: {
          name,
          runtime: runtime.value,
          start: $('#nb-start', modal).checked,
          autostart: $('#nb-autostart', modal).checked
        }
      });
      closeModal();
      toast(`Bot "${name}" created`, 'success');
      await loadOverview();
      navigate(`/bot/${data.bot.id}/console`);
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
      button.disabled = false;
      button.innerHTML = `${icon('plus', 'sm')} Create bot`;
    }
  };

  $('#nb-create', modal).addEventListener('click', create);
  $('#nb-name', modal).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') create();
  });
}

/* -------------------------- panel settings -------------------------- */

function renderSettingsView() {
  renderTopbar({
    title: 'Panel settings',
    subtitle: 'Appearance, security and storage',
    actions: ''
  });

  const system = state.overview && state.overview.system;
  const dirs = state.overview && state.overview.dirs;

  $('#content').innerHTML = `
    <div class="content-inner view-enter" style="max-width:900px">
      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>${icon('settings', 'sm')} Panel</h3></div>
          <div class="card-body">
            <div class="form-grid">
              <div class="field">
                <label>Panel name</label>
                <input class="input" id="panel-name-input" value="${esc(state.me ? state.me.panelName : 'BotDeck')}" maxlength="40">
                <div class="hint">Shown in the sidebar and browser tab.</div>
              </div>
              <div class="field">
                <label>Version</label>
                <input class="input mono" value="BotDeck ${esc((state.status && state.status.version) || '1.0.0')}" disabled>
                <div class="hint">Docker-free process manager</div>
              </div>
            </div>
            <div style="margin-top:16px">
              <button class="btn primary" data-action="save-panel-name">${icon('save', 'sm')} Save</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>${icon('lock', 'sm')} Admin password</h3></div>
          <div class="card-body">
            <div class="form-grid">
              <div class="field">
                <label>Current password</label>
                <input class="input" type="password" id="pw-current" autocomplete="current-password">
              </div>
              <div class="field">
                <label>New password</label>
                <input class="input" type="password" id="pw-next" autocomplete="new-password" placeholder="At least 8 characters">
              </div>
            </div>
            <div style="margin-top:16px">
              <button class="btn primary" data-action="change-password">${icon('lock', 'sm')} Update password</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>${icon('server', 'sm')} Server & storage</h3></div>
          <div class="info-list" id="settings-stats">
            ${settingsStatsHtml(system, dirs)}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>${icon('zap', 'sm')} How BotDeck runs bots</h3></div>
          <div class="card-body">
            <div class="hint-box">
              ${icon('zap', 'sm')}
              <div>Every bot is a plain OS process launched from its own folder — no Docker, no containers, no extra daemons.
              The panel supervises restarts, captures logs and manages files.</div>
            </div>
            <div class="stack" style="gap:10px;margin-top:16px;font-size:12.5px;color:var(--muted)">
              <div class="row">${icon('folder', 'sm')} Bot files: <span class="mono">${esc(dirs ? dirs.bots : '')}</span></div>
              <div class="row">${icon('file', 'sm')} Logs: <span class="mono">${esc(dirs ? dirs.data + '/logs' : '')}</span></div>
              <div class="row">${icon('terminal', 'sm')} Keep the panel alive with systemd: <span class="mono">systemctl restart botdeck</span></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>${icon('logout', 'sm')} Session</h3></div>
          <div class="card-body row-between" style="flex-wrap:wrap;gap:12px">
            <div class="muted small">Bots keep running on the server even when you sign out.</div>
            <button class="btn ghost" data-action="logout">${icon('logout', 'sm')} Sign out</button>
          </div>
        </div>
      </div>
    </div>`;
}

function settingsStatsHtml(system, dirs) {
  if (!system) return `<div class="info-row"><span class="k">Loading…</span></div>`;
  const rows = [
    ['server', 'Hostname', system.hostname],
    ['cpu', 'CPU', `${system.cpuModel} (${system.cores} cores)`],
    ['mem', 'Memory', `${fmtBytes(system.memory.total - system.memory.free)} / ${fmtBytes(system.memory.total)}`],
    ['disk', 'Disk', system.disk ? `${fmtBytes(system.disk.used)} / ${fmtBytes(system.disk.total)}` : 'not available'],
    ['clock', 'Server uptime', fmtDuration(system.uptime * 1000)],
    ['code', 'Node.js', system.nodeVersion],
    ['folder', 'Bots folder', dirs ? dirs.bots : '—'],
    ['file', 'Data folder', dirs ? dirs.data : '—']
  ];
  return rows
    .map(
      ([ic, key, value]) => `<div class="info-row">
        <span class="k">${icon(ic, 'xs')} ${esc(key)}</span>
        <span class="v mono" title="${esc(value)}">${esc(value)}</span>
      </div>`
    )
    .join('');
}

function syncSettingsStats() {
  const container = $('#settings-stats');
  if (!container || !state.overview) return;
  container.innerHTML = settingsStatsHtml(state.overview.system, state.overview.dirs);
}

async function savePanelName() {
  const input = $('#panel-name-input');
  if (!input) return;
  try {
    const data = await api('/api/settings', { method: 'PATCH', body: { panelName: input.value.trim() } });
    if (state.me) state.me.panelName = data.panelName;
    if (state.overview) state.overview.panelName = data.panelName;
    updatePanelName();
    toast('Panel name saved', 'success');
  } catch (err) {
    if (!err.isAuth) toast(err.message, 'error');
  }
}

async function changePassword() {
  const current = $('#pw-current').value;
  const next = $('#pw-next').value;
  if (!current || !next) return toast('Fill both password fields', 'error');
  if (next.length < 8) return toast('New password must be at least 8 characters', 'error');
  try {
    const data = await api('/api/auth/password', { method: 'POST', body: { current, next } });
    state.token = data.token;
    localStorage.setItem('bd_token', data.token);
    $('#pw-current').value = '';
    $('#pw-next').value = '';
    toast('Password updated', 'success');
  } catch (err) {
    if (!err.isAuth) toast(err.message, 'error');
  }
}

/* ------------------------------ events ------------------------------ */

const OP_LABELS = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', kill: 'Killing' };

async function runBotOp(botId, op) {
  const bot = botById(botId);
  const name = bot ? bot.name : 'bot';

  if (op === 'kill') {
    const confirmed = await confirmAction({
      title: 'Force kill bot',
      message: `Immediately SIGKILL <strong>${esc(name)}</strong>? Unsaved progress inside the bot may be lost.`,
      confirmText: 'Force kill'
    });
    if (!confirmed) return;
    try {
      await api(`/api/bots/${botId}/kill`, { method: 'POST' });
      toast(`Force killed ${name}`, 'success');
      await loadOverview();
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
    }
    return;
  }

  toast(`${OP_LABELS[op] || 'Working on'} ${name}…`, 'info', 2200);
  const buttons = $$(`[data-action="bot-op"][data-bot="${botId}"]`);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await api(`/api/bots/${botId}/${op}`, { method: 'POST' });
    await loadOverview();
    toast(`${name} ${op === 'start' ? 'started' : op === 'stop' ? 'stopped' : 'restarted'}`, 'success');
  } catch (err) {
    if (!err.isAuth) toast(err.message, 'error');
    await loadOverview();
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

document.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;
  const botId = trigger.dataset.bot;
  const path = trigger.dataset.path || '';

  switch (action) {
    case 'close-modal':
      closeModal();
      break;

    case 'open-sidebar':
      $('#app').classList.add('sidebar-open');
      break;

    case 'close-sidebar':
      closeSidebar();
      break;

    case 'new-bot':
      newBotDialog();
      break;

    case 'logout':
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch (_) { /* ignore */ }
      state.token = '';
      localStorage.removeItem('bd_token');
      state.me = null;
      showAuth(state.status || { setup: false, panelName: 'BotDeck' });
      break;

    case 'goto-bot':
      event.preventDefault();
      navigate(`/bot/${botId}/console`);
      break;

    case 'bot-op':
      event.preventDefault();
      event.stopPropagation();
      runBotOp(botId, trigger.dataset.op);
      break;

    case 'bulk': {
      const op = trigger.dataset.op;
      const confirmed = await confirmAction({
        title: op === 'start-all' ? 'Start all bots' : 'Stop all bots',
        message:
          op === 'start-all'
            ? 'Start every bot in the panel?'
            : 'Stop every running bot? They will stay stopped until started again.',
        confirmText: op === 'start-all' ? 'Start all' : 'Stop all',
        danger: op === 'stop-all'
      });
      if (!confirmed) break;
      try {
        const result = await api('/api/bots/actions', { method: 'POST', body: { action: op } });
        toast(`${result.ok} bot(s) updated${result.failed ? `, ${result.failed} failed` : ''}`, 'success');
        await loadOverview();
      } catch (err) {
        if (!err.isAuth) toast(err.message, 'error');
      }
      break;
    }

    case 'clear-logs':
      try {
        await api(`/api/bots/${botId}/logs`, { method: 'DELETE' });
        const term = $('#terminal');
        if (term) {
          term.innerHTML = '';
          showConsoleEmpty();
        }
        toast('Console cleared', 'success');
      } catch (err) {
        if (!err.isAuth) toast(err.message, 'error');
      }
      break;

    case 'download-logs': {
      const bot = botById(botId);
      downloadLogs(botId, bot && bot.name);
      break;
    }

    case 'add-env':
      addEnvRow();
      break;

    case 'remove-env': {
      const row = trigger.closest('[data-env-row]');
      if (row) row.remove();
      break;
    }

    case 'save-bot':
      saveBotSettings(botId);
      break;

    case 'clone-bot':
      cloneBotDialog(botId);
      break;

    case 'delete-bot':
      deleteBotDialog(botId);
      break;

    case 'files-refresh':
      loadFiles(botId, state.filePath);
      break;

    case 'files-open-dir':
      loadFiles(botId, path);
      break;

    case 'files-new-file':
      newFileDialog(botId);
      break;

    case 'files-new-folder':
      newFolderDialog(botId);
      break;

    case 'files-upload': {
      state.uploadBotId = botId;
      state.uploadDir = state.filePath;
      const input = $('#upload-input');
      input.value = '';
      input.click();
      break;
    }

    case 'files-edit':
      openEditor(botId, path);
      break;

    case 'files-download':
      downloadFile(botId, path);
      break;

    case 'files-rename':
      renameDialog(botId, path);
      break;

    case 'files-delete':
      deleteFileDialog(botId, path);
      break;

    case 'files-extract':
      extractDialog(botId, path);
      break;

    case 'save-panel-name':
      savePanelName();
      break;

    case 'change-password':
      changePassword();
      break;

    default:
      break;
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;

  if (form.id === 'console-form') {
    event.preventDefault();
    const input = $('#console-input');
    if (!input || !input.value.trim()) return;
    const line = input.value;
    input.value = '';
    try {
      await api(`/api/bots/${form.dataset.bot}/input`, { method: 'POST', body: { data: line + '\n' } });
      appendLog({ t: Date.now(), s: 'sys', m: `› ${line}` });
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if ($('#modal-root').children.length) closeModal();
    else closeSidebar();
  }
});

/* Upload input */
const uploadInput = $('#upload-input');
if (uploadInput) {
  uploadInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length || !state.uploadBotId) return;
    const botId = state.uploadBotId;
    const dir = state.uploadDir;
    state.uploadBotId = null;
    state.uploadDir = null;
    await uploadFiles(botId, dir, files);
  });
}

/* ------------------------------- boot ------------------------------- */

window.addEventListener('hashchange', () => {
  if (!state.me) return;
  onRoute();
});

(async function boot() {
  try {
    state.status = await api('/api/auth/status');
  } catch (err) {
    if (state.token) {
      // server may be up but auth status failing; still attempt
    }
    state.status = { setup: false, panelName: 'BotDeck' };
  }

  if (state.token) {
    try {
      state.me = await api('/api/me');
    } catch (err) {
      if (err.isAuth) {
        state.token = '';
        localStorage.removeItem('bd_token');
      }
    }
  }

  if (state.me) {
    await startApp();
  } else {
    showAuth(state.status);
  }
})();
