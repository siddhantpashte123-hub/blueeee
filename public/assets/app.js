/* Forge — frontend. Vanilla JS, koi framework nahi. */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const S = {
    authed: false,
    needsSetup: false,
    system: null,
    chats: [],
    chat: null,
    streaming: false,
    abortCtrl: null,
    streamBuf: '',
    tree: [],
    openFile: null,
    fileDirty: false,
    tab: 'files',
    asideOpen: true,
    sidebarOpen: false,
    models: null,
    attach: [],
    pollTimer: null,
    previewHtml: null
  };
  const codeStore = [];
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ------------------------------------------------------------- helpers
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtBytes(n) {
    n = Number(n) || 0;
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n >= 10 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }

  function toast(msg, kind = '') {
    let box = $('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 260);
    }, kind === 'err' ? 5200 : 2800);
  }

  async function api(path, opts = {}) {
    const o = Object.assign({ headers: {} }, opts);
    if (o.body && typeof o.body !== 'string') {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.body);
    }
    const res = await fetch(path, o);
    const txt = await res.text();
    let data = {};
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = { error: txt };
    }
    if (res.status === 401) {
      S.authed = false;
      renderAuth(false);
      throw new Error(data.error || 'Login karein');
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ------------------------------------------------------------- markdown
  function inlineMd(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, (_, c) => `<code class="inline">${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }

  function renderMarkdown(src) {
    const lines = String(src || '').split('\n');
    const out = [];
    let i = 0;
    let listType = null;

    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // code fence
      const fence = /^```(.*)$/.exec(line);
      if (fence) {
        closeList();
        const info = fence[1].trim();
        const lang = (info.split(/\s+/)[0] || '').toLowerCase();
        const pathM = /(?:path|file|filename)=([^\s]+)/i.exec(info);
        const filePath = pathM ? pathM[1].replace(/^["'`]|["'`]$/g, '') : '';
        const body = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
        i++; // skip closing fence
        const code = body.join('\n');
        const idx = codeStore.push({ code, path: filePath, lang }) - 1;
        out.push(`<div class="code-block">
          <div class="code-head">
            <span>${esc(lang || 'code')}</span>
            ${filePath ? `<span class="path">${esc(filePath)}</span>` : ''}
            <span class="grow"></span>
            ${filePath ? `<button class="sm" data-apply="${idx}">Apply</button>` : ''}
            <button class="sm ghost" data-copy="${idx}">Copy</button>
          </div>
          <div class="code-body"><pre>${highlight(code, lang)}</pre></div>
        </div>`);
        continue;
      }

      // heading
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        closeList();
        out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`);
        i++;
        continue;
      }

      // hr
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
        closeList();
        out.push('<hr/>');
        i++;
        continue;
      }

      // blockquote
      if (/^>\s?/.test(line)) {
        closeList();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${inlineMd(buf.join(' '))}</blockquote>`);
        continue;
      }

      // list
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (listType !== want) {
          closeList();
          out.push(`<${want}>`);
          listType = want;
        }
        out.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
        i++;
        continue;
      }

      // blank
      if (!line.trim()) {
        closeList();
        i++;
        continue;
      }

      // paragraph
      closeList();
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*[-*+]\s|^\s*\d+[.)]\s|^>/.test(lines[i])) {
        buf.push(lines[i++]);
      }
      out.push(`<p>${inlineMd(buf.join(' '))}</p>`);
    }
    closeList();
    return out.join('\n');
  }

  // ------------------------------------------------------------- highlight
  const KEYWORDS =
    'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|this|super|null|undefined|true|false|void|delete|in|of|def|elif|lambda|pass|with|as|and|or|not|is|None|True|False|print|SELECT|INSERT|UPDATE|DELETE|CREATE|TABLE|FROM|WHERE|JOIN|GROUP|ORDER|BY';

  function highlight(code, lang) {
    const esc2 = esc(code);
    if (!lang || ['text', 'txt', 'plain', ''].includes(lang)) return esc2;

    if (['html', 'xml', 'svg', 'vue'].includes(lang)) {
      return esc2
        .replace(/(&lt;\/?)([a-zA-Z][\w:-]*)/g, '$1<span class="tok-tag">$2</span>')
        .replace(/([a-zA-Z-]+)=(&quot;[^&]*?&quot;|'[^']*?')/g, '<span class="tok-attr">$1</span>=<span class="tok-str">$2</span>')
        .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-com">$1</span>');
    }

    if (['css', 'scss', 'less'].includes(lang)) {
      return esc2
        .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-com">$1</span>')
        .replace(/([.#][\w-]+)(?=[^{]*\{)/g, '<span class="tok-fn">$1</span>')
        .replace(/([\w-]+)(\s*:\s*)([^;{}]+)/g, '<span class="tok-attr">$1</span>$2<span class="tok-str">$3</span>');
    }

    const re = new RegExp(
      '(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|--[^\\n]*)' + // comments
        '|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)' + // strings
        `|\\b(${KEYWORDS})\\b` + // keywords
        '|\\b(\\d+(?:\\.\\d+)?)\\b' + // numbers
        '|([A-Za-z_$][\\w$]*)(?=\\s*\\()', // function calls
      'g'
    );
    return esc2.replace(re, (m, com, str, kw, num, fn) => {
      if (com) return `<span class="tok-com">${com}</span>`;
      if (str) return `<span class="tok-str">${str}</span>`;
      if (kw) return `<span class="tok-key">${kw}</span>`;
      if (num) return `<span class="tok-num">${num}</span>`;
      if (fn) return `<span class="tok-fn">${fn}</span>`;
      return m;
    });
  }

  // ------------------------------------------------------------- auth
  function renderAuth(setup) {
    S.needsSetup = setup;
    if (S.abortCtrl) S.abortCtrl.abort();
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="brand"><img src="/assets/favicon.svg" alt=""/>Forge</div>
          <p class="lead">${
            setup
              ? 'Pehli baar? Panel ka password set karein — ye AI aapke VPS par hi chalta hai, koi cloud nahi.'
              : 'Login karein aur code likhna shuru karein.'
          }</p>
          <form id="auth-form">
            <label class="field"><span class="lbl">${setup ? 'Naya password' : 'Password'}</span>
              <input type="password" id="pw" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="••••••••" autofocus/>
              ${setup ? '<span class="hint">Kam se kam 6 characters.</span>' : ''}
            </label>
            ${setup ? '<label class="field"><span class="lbl">Dobara likhein</span><input type="password" id="pw2" autocomplete="new-password"/></label>' : ''}
            <button class="primary" style="width:100%;justify-content:center" type="submit">${setup ? 'Set password' : 'Login'}</button>
          </form>
          <p style="text-align:center;color:var(--txt-mute);font-size:11.5px;margin:16px 0 0">
            100% local · llama.cpp engine · koi API key nahi
          </p>
        </div>
      </div>`;

    const form = $('#auth-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const pw = $('#pw').value;
        if (setup) {
          if (pw !== $('#pw2').value) throw new Error('Dono password same nahi hain');
          await api('/api/auth/setup', { method: 'POST', body: { password: pw } });
        } else {
          await api('/api/auth/login', { method: 'POST', body: { password: pw } });
        }
        S.authed = true;
        await boot();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    };
  }

  // ------------------------------------------------------------- shell
  function shell() {
    app.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <button class="icon ghost mobile-only" id="btn-sidebar" title="Chats">☰</button>
          <div class="brand"><img src="/assets/favicon.svg" alt=""/>Forge <span class="sub">local ai studio</span></div>
          <div class="grow"></div>
          <div class="top-stats" id="top-stats"></div>
          <button class="sm ghost" id="btn-models">Models</button>
          <button class="sm ghost" id="btn-settings" title="Settings">⚙</button>
          <button class="icon ghost mobile-only" id="btn-aside" title="Workspace">⌘</button>
        </header>
        <div class="main" id="main">
          <aside class="sidebar" id="sidebar">
            <div class="sidebar-head">
              <button class="btn-new" id="btn-newchat">＋ Naya chat</button>
            </div>
            <div class="chat-list" id="chat-list"></div>
            <div class="sidebar-foot">
              <div class="engine-box" id="engine-box"></div>
              <button class="sm ghost" id="btn-engine">Engine manage</button>
            </div>
          </aside>

          <main class="chat-pane">
            <div class="chat-head">
              <span class="title" id="chat-title">Naya chat</span>
              <span class="grow" style="flex:1"></span>
              <select id="preset" class="sm" style="width:auto;padding:4px 8px;font-size:12px;background:var(--panel-2);border:1px solid var(--line);border-radius:7px"></select>
              <button class="sm ghost" id="btn-rename" title="Rename">✎</button>
              <button class="sm ghost" id="btn-delchat" title="Delete chat">🗑</button>
            </div>
            <div class="chat-scroll" id="chat-scroll">
              <div class="chat-inner" id="chat-inner"></div>
            </div>
            <div class="composer-wrap">
              <div class="composer">
                <textarea id="prompt" rows="1" placeholder="Kya banana hai? jaise: 'ek premium login page banao glassmorphism ke saath'"></textarea>
                <div class="composer-bar">
                  <button class="sm ghost" id="btn-attach" title="Project files attach karein">📎 <span id="attach-count"></span></button>
                  <label class="switch" title="Workspace ki files context me bhejein">
                    <input type="checkbox" id="ctx-toggle"/> context
                  </label>
                  <span class="attach-note" id="composer-note"></span>
                  <span class="grow"></span>
                  <button class="sm ghost" id="btn-stop" style="display:none">■ Stop</button>
                  <button class="btn-send" id="btn-send" title="Send (Enter)">➤</button>
                </div>
              </div>
            </div>
          </main>

          <aside class="aside" id="aside">
            <div class="aside-tabs">
              <button data-tab="files" class="active">Files</button>
              <button data-tab="preview">Preview</button>
              <span class="grow" style="flex:1"></span>
              <button class="sm ghost" id="btn-zip" title="Project ZIP">⬇</button>
              <button class="sm ghost" id="btn-close-aside" title="Hide">✕</button>
            </div>
            <div class="aside-body" id="aside-body"></div>
          </aside>
        </div>
      </div>`;

    $('#btn-newchat').onclick = newChat;
    $('#btn-models').onclick = openModels;
    $('#btn-engine').onclick = openModels;
    $('#btn-settings').onclick = openSettings;
    $('#btn-send').onclick = send;
    $('#btn-stop').onclick = stopStream;
    $('#btn-attach').onclick = openAttachMenu;
    $('#btn-zip').onclick = () => (location.href = '/api/files/zip');
    $('#btn-close-aside').onclick = () => {
      $('#main').classList.remove('aside-open');
      $('#aside').style.display = 'none';
    };
    $('#btn-aside').onclick = () => {
      $('#aside').style.display = '';
      $('#main').classList.toggle('aside-open');
    };
    $('#btn-sidebar').onclick = () => $('#main').classList.toggle('sidebar-open');
    $('#btn-delchat').onclick = deleteChat;
    $('#btn-rename').onclick = renameChat;
    $('#preset').onchange = async () => {
      if (S.chat) {
        await api(`/api/chats/${S.chat.id}`, { method: 'PATCH', body: { preset: $('#preset').value } }).catch(() => {});
        S.chat.preset = $('#preset').value;
      }
      await api('/api/settings', { method: 'POST', body: { preset: $('#preset').value } }).catch(() => {});
    };

    const ta = $('#prompt');
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!S.streaming) send();
      }
    });

    $$('.aside-tabs button[data-tab]').forEach((b) => {
      b.onclick = () => {
        S.tab = b.dataset.tab;
        $$('.aside-tabs button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
        renderAside();
      };
    });

    $('#chat-inner').addEventListener('click', onChatClick);
    renderAside();
  }

  function onChatClick(e) {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const item = codeStore[Number(copyBtn.dataset.copy)];
      navigator.clipboard.writeText(item.code).then(() => toast('Copy ho gaya', 'ok'));
      return;
    }
    const applyBtn = e.target.closest('[data-apply]');
    if (applyBtn) {
      const item = codeStore[Number(applyBtn.dataset.apply)];
      applyFiles([{ path: item.path, content: item.code }]);
      return;
    }
    if (e.target.closest('[data-sugg]')) {
      const btn = e.target.closest('[data-sugg]');
      $('#prompt').value = btn.dataset.sugg;
      send();
    }
  }

  async function applyFiles(files) {
    try {
      const d = await api('/api/files/apply', { method: 'POST', body: { files } });
      toast(`${d.files.length} file workspace me likhi`, 'ok');
      await loadTree();
      renderAside();
      if (files.some((f) => /\.html?$/i.test(f.path))) {
        S.tab = 'preview';
        $$('.aside-tabs button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'preview'));
        await loadPreview();
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // ------------------------------------------------------------- sidebar / chats
  function renderChatList() {
    const list = $('#chat-list');
    if (!list) return;
    if (!S.chats.length) {
      list.innerHTML = '<div style="padding:14px;color:var(--txt-mute);font-size:12.5px;text-align:center">Koi chat nahi — naya banao</div>';
      return;
    }
    list.innerHTML = S.chats
      .map(
        (c) => `<div class="chat-item ${S.chat && S.chat.id === c.id ? 'active' : ''}" data-id="${c.id}">
          <span class="t">${esc(c.title || 'Chat')}</span>
          <span class="x" data-del="${c.id}">×</span>
        </div>`
      )
      .join('');
    $$('.chat-item', list).forEach((el) => {
      el.onclick = async (e) => {
        if (e.target.dataset.del) {
          e.stopPropagation();
          await api(`/api/chats/${e.target.dataset.del}`, { method: 'DELETE' }).catch(() => {});
          await loadChats();
          if (S.chat && S.chat.id === e.target.dataset.del) newChat();
          return;
        }
        await openChat(el.dataset.id);
        $('#main').classList.remove('sidebar-open');
      };
    });
  }

  async function loadChats() {
    const d = await api('/api/chats');
    S.chats = d.chats || [];
    renderChatList();
  }

  async function newChat() {
    S.chat = { id: null, title: 'Naya chat', messages: [], preset: $('#preset') ? $('#preset').value : 'engineer' };
    S.streamBuf = '';
    $('#chat-title').textContent = 'Naya chat';
    renderChat();
    $('#prompt').focus();
  }

  async function openChat(id) {
    const d = await api(`/api/chats/${id}`);
    S.chat = d.chat;
    if ($('#preset')) $('#preset').value = S.chat.preset || 'engineer';
    $('#chat-title').textContent = S.chat.title || 'Chat';
    renderChat();
    renderChatList();
    scrollBottom(true);
  }

  async function deleteChat() {
    if (!S.chat || !S.chat.id) return newChat();
    if (!confirm('Ye chat delete karein?')) return;
    await api(`/api/chats/${S.chat.id}`, { method: 'DELETE' }).catch(() => {});
    await loadChats();
    newChat();
  }

  async function renameChat() {
    if (!S.chat || !S.chat.id) return;
    const t = prompt('Naya naam', S.chat.title || '');
    if (!t) return;
    await api(`/api/chats/${S.chat.id}`, { method: 'PATCH', body: { title: t } }).catch(() => {});
    S.chat.title = t;
    $('#chat-title').textContent = t;
    await loadChats();
  }

  // ------------------------------------------------------------- chat render
  function renderChat() {
    const inner = $('#chat-inner');
    if (!inner) return;
    const msgs = (S.chat && S.chat.messages) || [];
    if (!msgs.length && !S.streamBuf) {
      inner.innerHTML = `
        <div class="empty-chat">
          <div class="big">Bolo, kya banayein?</div>
          <div class="sub">Local model aapke VPS par chal raha hai — code likhega, files workspace me jayengi.</div>
          <div class="suggestions">
            ${[
              ['Premium landing page', 'Glassmorphism hero, pricing, mobile responsive — ek page me.', 'Ek premium SaaS landing page banao glassmorphism hero ke saath, dark theme, pricing section aur mobile responsive. Poora HTML+CSS ek hi file me.'],
              ['REST API + tests', 'Node.js Express API, validation, tests.', 'Ek Node.js REST API banao (Express) users CRUD ke liye — validation, error handling, aur ek test file. Har file poora likho.'],
              ['Bug dhoondho', 'Code paste karo, root cause + fix.', 'Mera code kaam nahi kar raha — root cause batao aur fix karo:\n\n```js\n// apna code yahan paste karo\n```'],
              ['Python script', 'CSV clean karke report banane wali script.', 'Ek Python script banao jo CSV file clean kare (duplicate, missing values) aur summary report print kare — argparse ke saath.']
            ]
              .map(
                ([t, d, p]) => `<div class="sugg" data-sugg="${esc(p)}"><b>${esc(t)}</b><span>${esc(d)}</span></div>`
              )
              .join('')}
          </div>
        </div>`;
      return;
    }
    inner.innerHTML =
      msgs
        .map(
          (m) => `<div class="msg ${m.role === 'user' ? 'user' : 'ai'}">
            <div class="avatar">${m.role === 'user' ? 'You' : 'AI'}</div>
            <div class="bubble">
              <div class="who">${m.role === 'user' ? 'Aap' : 'Forge'}${m.model ? ` · ${esc(m.model)}` : ''}</div>
              <div class="md">${renderMarkdown(m.content)}</div>
            </div>
          </div>`
        )
        .join('') +
      (S.streaming || S.streamBuf
        ? `<div class="msg ai streaming" id="stream-msg">
             <div class="avatar">AI</div>
             <div class="bubble">
               <div class="who">Forge · likh raha hai…</div>
               <div class="md" id="stream-md">${
                 S.streamBuf
                   ? renderMarkdown(S.streamBuf)
                   : '<span class="thinking"><i></i><i></i><i></i></span>'
               }<span class="cursor"></span></div>
             </div>
           </div>`
        : '');
    renderChatList();
  }

  function updateStream() {
    const el = $('#stream-md');
    if (!el) {
      renderChat();
      return;
    }
    el.innerHTML = renderMarkdown(S.streamBuf) + '<span class="cursor"></span>';
    const sc = $('#chat-scroll');
    if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 220) scrollBottom();
  }

  function scrollBottom(force) {
    const sc = $('#chat-scroll');
    if (sc) sc.scrollTop = force ? sc.scrollHeight : sc.scrollHeight;
  }

  // ------------------------------------------------------------- send / stream
  async function send() {
    const ta = $('#prompt');
    const text = ta.value.trim();
    if (!text || S.streaming) return;

    if (!S.chat) S.chat = { id: null, messages: [], preset: 'engineer' };
    S.chat.messages.push({ role: 'user', content: text, ts: Date.now() });
    ta.value = '';
    ta.style.height = 'auto';
    S.streaming = true;
    S.streamBuf = '';
    S.abortCtrl = new AbortController();
    $('#btn-stop').style.display = '';
    $('#btn-send').disabled = true;
    renderChat();
    scrollBottom(true);

    const payload = {
      chatId: S.chat.id,
      message: text,
      preset: $('#preset').value,
      files: S.attach,
      temperature: S.system ? S.system.settings.temperature : 0.2,
      maxTokens: S.system ? S.system.settings.maxTokens : 1600
    };

    let res;
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: S.abortCtrl.signal
      });
    } catch (e) {
      finishStream();
      toast('Connection fail: ' + e.message, 'err');
      return;
    }

    if (!res.ok) {
      const t = await res.text();
      let msg = t;
      try {
        msg = JSON.parse(t).error;
      } catch {}
      finishStream();
      toast(msg || 'Chat fail', 'err');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastRender = 0;
    let doneData = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev;
            try {
              ev = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (ev.type === 'start') {
              S.chat.id = ev.chatId;
              $('#chat-title').textContent = S.chat.title || 'Chat';
            } else if (ev.type === 'token') {
              S.streamBuf += ev.t;
              const now = Date.now();
              if (now - lastRender > 70) {
                lastRender = now;
                updateStream();
              }
            } else if (ev.type === 'done') {
              doneData = ev;
            } else if (ev.type === 'error') {
              toast(ev.error, 'err');
            }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message, 'err');
    }

    finishStream();

    if (S.streamBuf || (doneData && doneData.aborted)) {
      S.chat.messages.push({ role: 'assistant', content: S.streamBuf, ts: Date.now() });
    }
    S.streamBuf = '';
    renderChat();
    scrollBottom();

    if (doneData) {
      if (doneData.chatTitle) {
        S.chat.title = doneData.chatTitle;
        $('#chat-title').textContent = doneData.chatTitle;
      }
      if (doneData.tokensPerSec) {
        const chip = $('#top-stats .tok-rate');
        if (chip) chip.textContent = `${doneData.tokensPerSec} tok/s`;
      }
      if (doneData.applied && doneData.applied.length) {
        toast(doneData.applied.length + ' file auto-apply hui', 'ok');
        await loadTree();
        renderAside();
      } else if (doneData.files && doneData.files.length) {
        toast(`${doneData.files.length} file mili — "Apply" dabayein`, 'ok');
      }
    }
    await loadChats();
  }

  function finishStream() {
    S.streaming = false;
    S.abortCtrl = null;
    $('#btn-stop').style.display = 'none';
    $('#btn-send').disabled = false;
    S.attach = [];
    renderAttachCount();
  }

  async function stopStream() {
    if (!S.streaming) return;
    api('/api/chat/stop', { method: 'POST' }).catch(() => {});
    if (S.abortCtrl) S.abortCtrl.abort();
  }

  // ------------------------------------------------------------- attach menu
  async function openAttachMenu() {
    const tree = S.tree.filter((e) => e.type === 'file');
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `<div class="head">Project se context</div>` +
      (tree.length
        ? tree
            .slice(0, 60)
            .map(
              (f) => `<div class="item" data-path="${esc(f.path)}">
                <input type="checkbox" ${S.attach.includes(f.path) ? 'checked' : ''} style="accent-color:var(--orange)"/>
                <span>${esc(f.path)}</span></div>`
            )
            .join('')
        : '<div class="item">Workspace khali hai</div>');
    document.body.appendChild(menu);
    const r = $('#btn-attach').getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.bottom = window.innerHeight - r.top + 8 + 'px';

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.item[data-path]');
      if (!item) return;
      const p = item.dataset.path;
      const cb = item.querySelector('input');
      cb.checked = !cb.checked;
      if (cb.checked) S.attach.push(p);
      else S.attach = S.attach.filter((x) => x !== p);
      S.attach = [...new Set(S.attach)];
      renderAttachCount();
    });
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  function renderAttachCount() {
    const el = $('#attach-count');
    if (el) el.textContent = S.attach.length ? `(${S.attach.length})` : '';
  }

  // ------------------------------------------------------------- workspace
  async function loadTree() {
    const d = await api('/api/files');
    S.tree = d.tree || [];
    return S.tree;
  }

  async function loadPreview() {
    const d = await api('/api/preview');
    S.previewHtml = d;
    renderAside();
  }

  function renderAside() {
    const body = $('#aside-body');
    if (!body) return;
    if (S.tab === 'files') {
      if (S.openFile) {
        body.innerHTML = `
          <div class="editor">
            <div class="editor-head">
              <span class="path">${esc(S.openFile.path)}</span>
              <span class="grow" style="flex:1"></span>
              <button class="sm" id="file-save">Save</button>
              <button class="sm ghost" id="file-close">✕</button>
            </div>
            <textarea id="file-content" spellcheck="false"></textarea>
            <div class="editor-foot">
              <span class="attach-note" id="file-meta">${S.openFile.content.length} chars</span>
              <span class="grow" style="flex:1"></span>
              <button class="sm ghost danger" id="file-del">Delete</button>
            </div>
          </div>`;
        const ta = $('#file-content');
        ta.value = S.openFile.content;
        ta.addEventListener('input', () => {
          $('#file-meta').textContent = ta.value.length + ' chars (unsaved)';
        });
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const s = ta.selectionStart;
            ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
            ta.selectionStart = ta.selectionEnd = s + 2;
          }
        });
        $('#file-save').onclick = async () => {
          try {
            await api('/api/file', { method: 'PUT', body: { path: S.openFile.path, content: ta.value } });
            S.openFile.content = ta.value;
            toast('Save ho gaya', 'ok');
            await loadTree();
          } catch (e) {
            toast(e.message, 'err');
          }
        };
        $('#file-close').onclick = () => {
          S.openFile = null;
          renderAside();
        };
        $('#file-del').onclick = async () => {
          if (!confirm(`${S.openFile.path} delete karein?`)) return;
          try {
            await api(`/api/file?path=${encodeURIComponent(S.openFile.path)}`, { method: 'DELETE' });
            S.openFile = null;
            await loadTree();
            renderAside();
            toast('Delete ho gaya', 'ok');
          } catch (e) {
            toast(e.message, 'err');
          }
        };
        return;
      }
      const rows = S.tree
        .map((e) => {
          const depth = e.path.split('/').length - 1;
          const ico = e.type === 'dir' ? '📁' : fileIcon(e.name);
          return `<div class="tree-row ${e.type === 'dir' ? 'dir' : ''}" data-path="${esc(e.path)}" data-type="${e.type}" style="padding-left:${8 + depth * 12}px">
            <span class="ico">${ico}</span><span class="nm">${esc(e.name)}</span>
            ${e.type === 'file' ? `<span class="grow" style="flex:1"></span><span class="ico" style="opacity:.45">${fmtBytes(e.size)}</span>` : ''}
          </div>`;
        })
        .join('');
      body.innerHTML = `<div class="tree">${
        rows || '<div class="tree-empty">Workspace khali hai.<br/>AI se code banwao — files yahan aa jayengi.</div>'
      }</div>`;
      $$('.tree-row[data-type="file"]', body).forEach((row) => {
        row.onclick = async () => {
          try {
            const d = await api(`/api/file?path=${encodeURIComponent(row.dataset.path)}`);
            S.openFile = d;
            renderAside();
          } catch (e) {
            toast(e.message, 'err');
          }
        };
      });
      return;
    }

    // preview tab
    body.innerHTML = `
      <div class="preview-bar">
        <span>${S.previewHtml && S.previewHtml.entry ? esc(S.previewHtml.entry) : 'koi html nahi'}</span>
        <span class="grow" style="flex:1"></span>
        <button class="sm ghost" id="pv-refresh">↻</button>
      </div>
      ${
        S.previewHtml && S.previewHtml.html
          ? `<iframe class="preview-frame" id="pv-frame" sandbox="allow-scripts allow-forms allow-modals"></iframe>`
          : `<div class="tree-empty">${esc((S.previewHtml && S.previewHtml.message) || 'Preview load karne ke liye ↻ dabayein')}</div>`
      }`;
    const frame = $('#pv-frame');
    if (frame && S.previewHtml) frame.srcdoc = S.previewHtml.html;
    const rf = $('#pv-refresh');
    if (rf)
      rf.onclick = async () => {
        await loadPreview();
        toast('Preview refresh', 'ok');
      };
    if (!S.previewHtml) loadPreview().catch(() => {});
  }

  function fileIcon(name) {
    if (/\.html?$/i.test(name)) return '🌐';
    if (/\.css$/i.test(name)) return '🎨';
    if (/\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(name)) return '📜';
    if (/\.py$/i.test(name)) return '🐍';
    if (/\.json$/i.test(name)) return '🧾';
    if (/\.md$/i.test(name)) return '📝';
    if (/\.(sh|bash)$/i.test(name)) return '🖥';
    if (/\.(png|jpg|svg|webp)$/i.test(name)) return '🖼';
    return '📄';
  }

  // ------------------------------------------------------------- top bar / engine
  async function refreshSystem() {
    try {
      S.system = await api('/api/system');
    } catch {
      return;
    }
    const sys = S.system;
    const eng = sys.engine || {};
    const stats = $('#top-stats');
    if (stats) {
      const cls = eng.status === 'ready' ? 'ok live' : eng.status === 'starting' ? 'warn live' : eng.status === 'error' ? 'err' : '';
      stats.innerHTML = `
        <span class="chip ${cls}" title="${esc(eng.error || '')}">
          <i class="dot"></i>${eng.status === 'ready' ? esc(eng.modelName || 'model') : eng.status}
        </span>
        <span class="chip hide-sm tok-rate">${eng.tokensPerSec ? eng.tokensPerSec + ' tok/s' : '— tok/s'}</span>
        <span class="chip hide-sm">${fmtBytes(sys.mem.free)} free</span>
        <span class="chip hide-sm">${sys.cpus} cores</span>`;
    }
    const eb = $('#engine-box');
    if (eb) {
      const cls = eng.status === 'ready' ? 'ok' : eng.status === 'error' ? 'err' : 'warn';
      eb.innerHTML = `<i class="dot chip ${cls}" style="width:7px;height:7px;border-radius:50%"></i>
        <span class="name">${eng.status === 'ready' ? esc(eng.modelName || 'model') : esc(eng.status)}</span>`;
    }
    const preset = $('#preset');
    if (preset && !preset.options.length && sys.presets) {
      preset.innerHTML = sys.presets.map((p) => `<option value="${p.id}">${p.icon} ${p.label}</option>`).join('');
      preset.value = (S.chat && S.chat.preset) || sys.settings.preset || 'engineer';
    }
    const ctx = $('#ctx-toggle');
    if (ctx && ctx.dataset.init !== '1') {
      ctx.checked = !!sys.settings.useProjectContext;
      ctx.dataset.init = '1';
      ctx.onchange = () => api('/api/settings', { method: 'POST', body: { useProjectContext: ctx.checked } }).catch(() => {});
    }
    const note = $('#composer-note');
    if (note && !S.streaming) note.textContent = eng.status === 'ready' ? '' : 'model load karein →';
  }

  // ------------------------------------------------------------- models modal
  function closeModal() {
    $$('.backdrop').forEach((b) => b.remove());
  }

  function modal(html, { wide = false } = {}) {
    closeModal();
    const back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
    back.addEventListener('click', (e) => {
      if (e.target === back) closeModal();
    });
    document.body.appendChild(back);
    return back;
  }

  async function openModels() {
    const back = modal(`<h2>Models</h2><p class="sub">Local GGUF models. Jitni RAM hai utna model chunein.</p><div id="models-body">Loading…</div>`, { wide: true });
    const render = async () => {
      let d;
      try {
        d = await api('/api/models');
      } catch (e) {
        $('#models-body', back).innerHTML = `<div style="color:var(--red)">${esc(e.message)}</div>`;
        return;
      }
      S.models = d;
      const eng = d.engine || {};
      const installing = d.catalog.filter((c) => c.download && !c.download.done && !c.download.error).length > 0;
      const loadingModel = eng.status === 'starting';

      const cards = d.catalog
        .map((c) => {
          const dl = c.download;
          const pct = dl && dl.total ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : 0;
          const inst = d.installed.find((i) => i.id === c.id);
          const isLoaded = inst && inst.loaded && eng.status === 'ready';
          let action = '';
          if (isLoaded) action = `<span class="tag good">loaded</span>`;
          else if (dl && !dl.done && !dl.error)
            action = `<div style="width:100%"><div class="bar"><i style="width:${pct}%"></i></div>
              <div class="meta">${fmtBytes(dl.received)}${dl.total ? ' / ' + fmtBytes(dl.total) : ''} (${pct}%)</div></div>`;
          else if (inst && inst.exists)
            action = `<button class="primary sm" data-load="${esc(c.id)}">Load</button>
                      <button class="sm ghost danger" data-rm="${esc(c.id)}">Delete</button>`;
          else if (dl && dl.error) action = `<button class="sm" data-dl="${esc(c.id)}">Retry</button>`;
          else action = `<button class="primary sm" data-dl="${esc(c.id)}">Download</button>`;
          return `<div class="model-card">
            <div class="nm">${esc(c.name)} ${c.id === d.recommend ? '<span class="tag good">recommended</span>' : ''}
              ${!c.fits ? '<span class="tag warn">RAM kam</span>' : ''}</div>
            <div class="meta">${esc(c.params)} · ${esc(c.quant)} · ${esc(c.sizeText)} · needs ~${c.ramGB} GB RAM</div>
            <div class="note">${esc(c.note)}</div>
            <div class="actions">${action}</div>
          </div>`;
        })
        .join('');

      const localCards = d.installed
        .filter((i) => !d.catalog.find((c) => c.id === i.id))
        .map(
          (i) => `<div class="model-card">
            <div class="nm">${esc(i.name)} <span class="tag">local file</span></div>
            <div class="meta">${esc(i.sizeText || '')}</div>
            <div class="actions">
              ${i.loaded && eng.status === 'ready' ? '<span class="tag good">loaded</span>' : `<button class="primary sm" data-load="${esc(i.id)}">Load</button>`}
              <button class="sm ghost danger" data-rm="${esc(i.id)}">Delete</button>
            </div>
          </div>`
        )
        .join('');

      $('#models-body', back).innerHTML = `
        <div class="row" style="margin-bottom:14px">
          <span class="chip ${eng.status === 'ready' ? 'ok' : eng.status === 'error' ? 'err' : 'warn'}"><i class="dot"></i>engine: ${esc(eng.status)}</span>
          <span class="chip">${esc(eng.modelName || 'koi model load nahi')}</span>
          <span class="chip">${fmtBytes(d.hostRamMB * 1048576)} RAM</span>
          <span class="grow" style="flex:1"></span>
          ${eng.status === 'ready' ? '<button class="sm ghost" id="m-unload">Unload</button>' : ''}
          <button class="sm ghost" id="m-logs">Logs</button>
        </div>
        ${loadingModel ? '<div class="chip warn" style="margin-bottom:12px"><i class="dot live"></i>model load ho raha hai… (bade model me 60s tak)</div>' : ''}
        ${eng.error ? `<div class="chip err" style="margin-bottom:12px">${esc(eng.error)}</div>` : ''}
        <div class="model-grid">${cards}${localCards}</div>

        <div style="margin-top:18px;border-top:1px solid var(--line-soft);padding-top:14px">
          <label class="field"><span class="lbl">Apna GGUF URL (HuggingFace ya koi bhi)</span>
            <div class="row">
              <input type="text" id="m-url" placeholder="https://huggingface.co/.../model-Q4_K_M.gguf" style="flex:1"/>
              <button class="sm" id="m-url-go">Download</button>
            </div>
            <span class="hint">Pehle se server par .gguf file ho to <code class="mono">data/models/</code> me rakhein aur Re-scan dabayein.</span>
          </label>
          <button class="sm ghost" id="m-rescan">↻ Re-scan folder</button>
        </div>
        <pre class="logs" id="m-logs-box" style="display:none"></pre>
        <div class="modal-foot"><button class="ghost" id="m-close">Band karein</button></div>`;

      const body = $('#models-body', back);
      $('#m-close', back).onclick = closeModal;
      $('#m-unload', back) &&
        ($('#m-unload', back).onclick = async () => {
          await api('/api/models/unload', { method: 'POST' }).catch(() => {});
          await refreshSystem();
          render();
        });
      $('#m-rescan', back).onclick = async () => {
        const r = await api('/api/models/refresh', { method: 'POST' }).catch(() => ({ added: 0 }));
        toast(r.added ? r.added + ' model mila' : 'Kuch naya nahi mila', 'ok');
        render();
      };
      $('#m-logs', back).onclick = async () => {
        const box = $('#m-logs-box', back);
        const d2 = await api('/api/models/logs');
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
        box.textContent = (d2.engine.logs || []).slice(-80).join('\n') || 'koi log nahi';
      };
      $('#m-url-go', back).onclick = async () => {
        const url = $('#m-url', back).value.trim();
        if (!url) return;
        try {
          await api('/api/models/download', { method: 'POST', body: { url } });
          toast('Download shuru', 'ok');
          render();
        } catch (e) {
          toast(e.message, 'err');
        }
      };

      $$('[data-dl]', body).forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            await api('/api/models/download', { method: 'POST', body: { id: b.dataset.dl } });
            toast('Download shuru — progress yahan dikhega', 'ok');
            render();
          } catch (e) {
            toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
      $$('[data-load]', body).forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          b.textContent = 'Loading…';
          try {
            const r = await api('/api/models/load', { method: 'POST', body: { id: b.dataset.load } });
            if (r.engine.status === 'ready') toast('Model ready — ab chat karein', 'ok');
            else toast(r.engine.error || 'Load fail — logs dekhein', 'err');
            await refreshSystem();
            render();
          } catch (e) {
            toast(e.message, 'err');
            await refreshSystem();
            render();
          }
        };
      });
      $$('[data-rm]', body).forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Model delete karein? (file disk se hat jayegi)')) return;
          try {
            await api(`/api/models/${encodeURIComponent(b.dataset.rm)}`, { method: 'DELETE' });
            toast('Delete ho gaya', 'ok');
            render();
          } catch (e) {
            toast(e.message, 'err');
          }
        };
      });

      if (installing || loadingModel) {
        clearTimeout(S.pollTimer);
        S.pollTimer = setTimeout(() => {
          if ($('#models-body', back)) render();
        }, 1500);
      }
    };
    await render();
    refreshSystem();
  }

  // ------------------------------------------------------------- settings
  function openSettings() {
    const sys = S.system || { settings: {} };
    const st = sys.settings || {};
    const back = modal(`
      <h2>Settings</h2>
      <p class="sub">Model behaviour aur panel password.</p>
      <label class="field"><span class="lbl">Temperature — ${st.temperature} <span class="hint" style="display:inline">(kam = focused code, zyada = creative)</span></span>
        <input type="range" id="s-temp" min="0" max="1.2" step="0.05" value="${st.temperature}"/>
      </label>
      <div class="row">
        <label class="field"><span class="lbl">Max tokens (jawab ki lambai)</span><input type="number" id="s-max" value="${st.maxTokens}" min="128" max="4096" step="64"/></label>
        <label class="field"><span class="lbl">Context size</span><input type="number" id="s-ctx" value="${st.ctxSize}" min="1024" max="32768" step="512"/></label>
      </div>
      <label class="switch" style="margin-bottom:10px"><input type="checkbox" id="s-auto" ${st.autoApply ? 'checked' : ''}/> Auto-apply — AI ki files seedha workspace me likho</label>
      <label class="switch" style="margin-bottom:16px"><input type="checkbox" id="s-ctxuse" ${st.useProjectContext ? 'checked' : ''}/> Project files context me bhejo</label>
      <div style="border-top:1px solid var(--line-soft);padding-top:14px">
        <label class="field"><span class="lbl">Password badlein</span>
          <div class="row"><input type="password" id="s-cur" placeholder="purana"/><input type="password" id="s-new" placeholder="naya"/></div>
        </label>
        <button class="sm" id="s-pw">Password update</button>
      </div>
      <div class="modal-foot"><button class="ghost" id="s-close">Band</button><button class="primary" id="s-save">Save</button></div>
    `);
    $('#s-close', back).onclick = closeModal;
    $('#s-save', back).onclick = async () => {
      try {
        const d = await api('/api/settings', {
          method: 'POST',
          body: {
            temperature: Number($('#s-temp', back).value),
            maxTokens: Number($('#s-max', back).value),
            ctxSize: Number($('#s-ctx', back).value),
            autoApply: $('#s-auto', back).checked,
            useProjectContext: $('#s-ctxuse', back).checked
          }
        });
        S.system.settings = d.settings;
        toast('Save ho gaya', 'ok');
        closeModal();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    $('#s-pw', back).onclick = async () => {
      try {
        await api('/api/panel/password', {
          method: 'POST',
          body: { current: $('#s-cur', back).value, next: $('#s-new', back).value }
        });
        toast('Password badal gaya', 'ok');
        $('#s-cur', back).value = '';
        $('#s-new', back).value = '';
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }

  // ------------------------------------------------------------- boot
  async function boot() {
    const st = await api('/api/auth/state').catch(() => ({ needsSetup: false, authed: false }));
    S.needsSetup = st.needsSetup;
    S.authed = st.authed || st.noAuth;
    if (!S.authed) return renderAuth(st.needsSetup);

    shell();
    await refreshSystem();
    await loadChats();
    await loadTree();
    await loadPreview();
    await newChat();

    // status polling
    setInterval(() => {
      if (!document.hidden) refreshSystem();
    }, 6000);
  }

  window.addEventListener('resize', () => {
    if (window.innerWidth > 980) $('#main') && $('#main').classList.remove('aside-open');
  });

  boot().catch((e) => {
    app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h2 style="margin-top:0">Kuch galat hua</h2>
      <p class="lead">${esc(e.message)}</p><button class="primary" style="width:100%;justify-content:center" onclick="location.reload()">Reload</button></div></div>`;
  });
})();
