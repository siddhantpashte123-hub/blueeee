'use strict';
/** Poora HTTP API — Forge ka dimaag. */
const os = require('os');
const cfg = require('./config');
const store = require('./store');
const auth = require('./auth');
const llm = require('./llm');
const models = require('./models');
const project = require('./project');
const prompts = require('./prompts');
const { memInfo, fmtBytes, uid } = require('./util');
const pkg = require('../package.json');

// ------------------------------------------------------------------ helpers
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function fail(res, err) {
  const code = err && err.status ? err.status : 500;
  if (code >= 500) console.error('[api]', err && err.stack ? err.stack : err);
  json(res, code, { error: (err && err.message) || 'Server error' });
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  return (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
}

function body(req, limit = cfg.MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const ip = (req) => (req.socket && req.socket.remoteAddress) || 'unknown';
const isSecure = (req) =>
  !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host || '');
  } catch {
    return false;
  }
}

/** code fences se files nikalo: ```js path=src/app.js */
function extractFiles(text) {
  const out = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text || ''))) {
    const info = (m[1] || '').trim();
    const code = m[2];
    const pm = /(?:path=|file=|filename=)([^\s`]+)/i.exec(info);
    if (!pm) continue;
    const p = pm[1]
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/^\/+/, '')
      .replace(/\.\.\//g, '');
    if (!p || p.length > 120) continue;
    out.push({ path: p, content: code.replace(/\n$/, '\n'), lang: info.split(/\s+/)[0] || '' });
  }
  return out;
}

function build(req) {
  const r = req.router;

  // ---------------------------------------------------------- public
  r.get('/api/health', async (req, res) => {
    const s = llm.status();
    json(res, 200, {
      ok: true,
      name: 'Forge',
      version: pkg.version,
      setupNeeded: auth.needsSetup(),
      engine: { mode: s.mode, status: s.status, model: s.modelName }
    });
  });

  r.get('/api/auth/state', async (req, res) => {
    const s = auth.sessionFromReq(req);
    json(res, 200, { needsSetup: auth.needsSetup(), authed: !!s, user: s ? s.user : null, noAuth: cfg.NO_AUTH });
  });

  r.post('/api/auth/setup', async (req, res) => {
    try {
      if (!auth.needsSetup()) throw Object.assign(new Error('Panel pehle se set hai'), { status: 409 });
      const b = await body(req);
      await auth.setPassword(b.password);
      const t = auth.createSession('admin', ip(req));
      res.setHeader('Set-Cookie', auth.sessionCookie(t, isSecure(req)));
      json(res, 200, { ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/api/auth/login', async (req, res) => {
    try {
      const addr = ip(req);
      if (auth.rateLimited(addr)) throw Object.assign(new Error('Bahut try — 5 min baad'), { status: 429 });
      const b = await body(req);
      const st = store.get();
      if (!st.auth || !auth.verifyPassword(b.password, st.auth.hash)) {
        auth.bumpTry(addr);
        throw Object.assign(new Error('Galat password'), { status: 401 });
      }
      auth.clearTries(addr);
      const t = auth.createSession(st.auth.user || 'admin', addr);
      res.setHeader('Set-Cookie', auth.sessionCookie(t, isSecure(req)));
      json(res, 200, { ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/api/auth/logout', async (req, res) => {
    const s = auth.sessionFromReq(req);
    if (s) auth.destroySession(s.token);
    res.setHeader('Set-Cookie', auth.clearCookie());
    json(res, 200, { ok: true });
  });

  // ---------------------------------------------------------- guard
  const guard = (fn) => async (req, res, ctx) => {
    const s = auth.sessionFromReq(req);
    if (!s) return json(res, 401, { error: 'Login karein' });
    if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Bad origin' });
    ctx.session = s;
    try {
      await fn(req, res, ctx);
    } catch (e) {
      if (!res.headersSent) fail(res, e);
      else {
        try {
          res.end();
        } catch {}
      }
    }
  };

  // ---------------------------------------------------------- system
  r.get('/api/system', guard(async (req, res) => {
    const st = store.get();
    const mem = memInfo();
    const ws = await project.stats();
    const eng = await llm.engineInfo();
    json(res, 200, {
      version: pkg.version,
      node: process.version,
      host: os.hostname(),
      uptime: process.uptime(),
      cpus: os.cpus().length,
      mem: { total: mem.total, free: mem.free, used: mem.used },
      load: os.loadavg(),
      engine: { ...llm.status(), available: eng.ready },
      settings: st.settings,
      workspace: ws,
      presets: Object.values(prompts.PRESETS).map((p) => ({ id: p.id, label: p.label, icon: p.icon, desc: p.desc })),
      recommendedModel: models.recommendFor().id
    });
  }));

  r.post('/api/settings', guard(async (req, res) => {
    const b = await body(req);
    const allowed = ['temperature', 'maxTokens', 'ctxSize', 'preset', 'useProjectContext', 'autoApply', 'modelId'];
    await store.update((s) => {
      for (const k of allowed) if (b[k] !== undefined) s.settings[k] = b[k];
      s.settings.temperature = Math.min(1.5, Math.max(0, Number(s.settings.temperature) || 0.2));
      s.settings.maxTokens = Math.min(4096, Math.max(64, parseInt(s.settings.maxTokens, 10) || 1600));
      s.settings.ctxSize = Math.min(32768, Math.max(1024, parseInt(s.settings.ctxSize, 10) || 4096));
    });
    json(res, 200, { ok: true, settings: store.get().settings });
  }));

  r.post('/api/panel/password', guard(async (req, res) => {
    const b = await body(req);
    const st = store.get();
    if (!auth.verifyPassword(b.current || '', st.auth.hash)) {
      throw Object.assign(new Error('Purana password galat hai'), { status: 401 });
    }
    await auth.setPassword(b.next);
    const t = auth.createSession('admin', ip(req));
    res.setHeader('Set-Cookie', auth.sessionCookie(t, isSecure(req)));
    json(res, 200, { ok: true });
  }));

  // ---------------------------------------------------------- models
  r.get('/api/models', guard(async (req, res) => {
    json(res, 200, { ...models.list(), engine: llm.status() });
  }));

  r.post('/api/models/refresh', guard(async (req, res) => {
    const added = await models.refreshFromDisk();
    json(res, 200, { ok: true, added });
  }));

  r.post('/api/models/download', guard(async (req, res) => {
    const b = await body(req);
    const p = await models.download(b.id || b.url, { url: b.url, name: b.name });
    json(res, 202, { ok: true, download: p });
  }));

  r.post('/api/models/load', guard(async (req, res) => {
    const b = await body(req);
    const st = await llm.load(b.id, { force: !!b.force });
    json(res, 200, { ok: st.status === 'ready', engine: st });
  }));

  r.post('/api/models/unload', guard(async (req, res) => {
    json(res, 200, { ok: true, engine: await llm.stop() });
  }));

  r.delete('/api/models/:id', guard(async (req, res, ctx) => {
    json(res, 200, await models.remove(ctx.params.id));
  }));

  r.get('/api/models/logs', guard(async (req, res) => {
    json(res, 200, { engine: llm.status() });
  }));

  // ---------------------------------------------------------- chats
  r.get('/api/chats', guard(async (req, res) => {
    json(res, 200, { chats: store.listChats() });
  }));

  r.post('/api/chats', guard(async (req, res) => {
    const b = await body(req).catch(() => ({}));
    const chat = await store.createChat({ title: b.title || 'Naya chat', preset: b.preset });
    json(res, 201, { chat });
  }));

  r.get('/api/chats/:id', guard(async (req, res, ctx) => {
    const chat = await store.getChat(ctx.params.id);
    if (!chat) return json(res, 404, { error: 'Chat nahi mila' });
    json(res, 200, { chat });
  }));

  r.patch('/api/chats/:id', guard(async (req, res, ctx) => {
    const chat = await store.getChat(ctx.params.id);
    if (!chat) return json(res, 404, { error: 'Chat nahi mila' });
    const b = await body(req);
    if (b.title) chat.title = String(b.title).slice(0, 80);
    if (b.preset) chat.preset = String(b.preset);
    await store.saveChat(chat);
    json(res, 200, { chat });
  }));

  r.delete('/api/chats/:id', guard(async (req, res, ctx) => {
    await store.deleteChat(ctx.params.id);
    json(res, 200, { ok: true });
  }));

  // ---------------------------------------------------------- chat stream
  r.post('/api/chat', guard(async (req, res) => {
    const b = await body(req);
    const message = String(b.message || '').trim();
    if (!message) return json(res, 400, { error: 'Message khali hai' });

    const st = store.get();
    let chat = b.chatId ? await store.getChat(b.chatId) : null;
    if (!chat) chat = await store.createChat({ title: message.slice(0, 48), preset: b.preset });

    const preset = b.preset || chat.preset || st.settings.preset;
    const attached = Array.isArray(b.files) ? b.files.slice(0, 8) : [];
    const attachedContents = [];
    for (const p of attached) {
      const f = await project.read(p).catch(() => null);
      if (f) attachedContents.push({ path: f.path, content: f.content });
    }

    let ctxFiles = [];
    let treeList = [];
    if (b.useContext !== false && st.settings.useProjectContext) {
      ctxFiles = await project.contextFiles(cfg.MAX_CONTEXT_FILES);
      treeList = await project.tree();
    }

    const system = prompts.buildSystemPrompt({
      preset,
      extra: b.extra || '',
      contextFiles: [...attachedContents, ...ctxFiles],
      projectTree: treeList
    });
    const messages = prompts.buildMessages({
      system,
      history: chat.messages,
      userMessage: message,
      maxChars: b.maxChars || 24000
    });

    const send = sse(res);
    res.write(': forge\n\n');
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    send({ type: 'start', chatId: chat.id, model: llm.state.modelName || 'local', preset });

    chat.messages.push({ role: 'user', content: message, ts: Date.now(), files: attached });
    if (chat.title === 'Naya chat' && chat.messages.length === 1) {
      chat.title = message.replace(/\s+/g, ' ').slice(0, 48);
    }

    let result;
    try {
      result = await llm.chat({
        messages,
        temperature: b.temperature != null ? Number(b.temperature) : st.settings.temperature,
        maxTokens: b.maxTokens != null ? Number(b.maxTokens) : st.settings.maxTokens,
        signal: abort.signal,
        onToken: (t) => send({ type: 'token', t })
      });
    } catch (e) {
      clearInterval(keepAlive);
      send({
        type: 'error',
        error: e.message,
        code: e.code || null,
        modelId: e.modelId || null,
        modelName: e.modelName || null
      });
      res.end();
      return;
    }

    clearInterval(keepAlive);
    const text = result.text || '';
    chat.messages.push({
      role: 'assistant',
      content: text,
      ts: Date.now(),
      aborted: !!result.aborted,
      model: llm.state.modelName || null
    });
    chat.preset = preset;
    await store.saveChat(chat);

    let applied = [];
    if (st.settings.autoApply && text) {
      const files = extractFiles(text);
      if (files.length) {
        const out = await project.applyFiles(files);
        applied = out.files;
      }
    }

    send({
      type: 'done',
      chatId: chat.id,
      chatTitle: chat.title,
      aborted: !!result.aborted,
      tokensPerSec: result.timings ? Math.round((result.timings.predicted_per_second || 0) * 10) / 10 : llm.state.lastTokensPerSec,
      tokens: result.timings ? result.timings.predicted_n : null,
      files: extractFiles(text).map((f) => f.path),
      applied
    });
    res.end();
  }));

  r.post('/api/chat/stop', guard(async (req, res) => {
    llm.stopAll();
    json(res, 200, { ok: true });
  }));

  // ---------------------------------------------------------- workspace files
  r.get('/api/files', guard(async (req, res) => {
    json(res, 200, { tree: await project.tree(), stats: await project.stats(), root: project.root() });
  }));

  r.get('/api/file', guard(async (req, res) => {
    const p = new URL(req.url, 'http://x').searchParams.get('path');
    json(res, 200, await project.read(p));
  }));

  r.put('/api/file', guard(async (req, res) => {
    const b = await body(req);
    json(res, 200, await project.write(b.path, b.content == null ? '' : b.content));
  }));

  r.delete('/api/file', guard(async (req, res) => {
    const p = new URL(req.url, 'http://x').searchParams.get('path');
    json(res, 200, await project.remove(p));
  }));

  r.post('/api/files/apply', guard(async (req, res) => {
    const b = await body(req);
    const files = Array.isArray(b.files) ? b.files : extractFiles(b.text || '');
    if (!files.length) throw Object.assign(new Error('Koi file nahi mili'), { status: 400 });
    json(res, 200, await project.applyFiles(files));
  }));

  r.get('/api/files/zip', guard(async (req, res) => {
    const buf = await project.zip();
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="forge-project.zip"',
      'Content-Length': buf.length
    });
    res.end(buf);
  }));

  r.get('/api/preview', guard(async (req, res) => {
    const p = new URL(req.url, 'http://x').searchParams.get('path');
    json(res, 200, await project.previewHtml(p));
  }));

  // ---------------------------------------------------------- misc
  r.get('/api/stats', guard(async (req, res) => {
    const mem = memInfo();
    json(res, 200, {
      engine: llm.status(),
      mem: { total: mem.total, free: mem.free, text: `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}` },
      workspace: await project.stats(),
      load: os.loadavg(),
      cpus: os.cpus().length
    });
  }));

  r.get('/api/extract', guard(async (req, res) => {
    const text = new URL(req.url, 'http://x').searchParams.get('text') || '';
    json(res, 200, { files: extractFiles(text) });
  }));

  return r;
}

module.exports = { build, extractFiles, json, fail };
