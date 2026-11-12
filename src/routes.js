'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { HttpError, uid, cleanString, safeJoin, formatBytes } = require('./util');
const { TEMPLATES } = require('./templates');
const files = require('./files');

const RUNTIMES = ['node', 'python', 'bash', 'custom'];

function attachmentName(name, fallback = 'download') {
  const clean = String(name || '')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return clean || fallback;
}
const ACTIONS = new Set(['start', 'stop', 'restart', 'kill']);

function validateEntry(entry) {
  const value = cleanString(entry, 300).trim();
  if (!value) return '';
  const norm = value.replace(/\\/g, '/');
  if (norm.startsWith('/')) throw new HttpError(400, 'Entry must be relative to the bot folder');
  if (norm.split('/').includes('..')) throw new HttpError(400, 'Entry path cannot contain ".."');
  return norm;
}

function parseEnv(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Environment variables must be a key/value object');
  }
  const entries = Object.entries(input);
  if (entries.length > 100) throw new HttpError(400, 'Maximum 100 environment variables');
  const out = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new HttpError(400, `Invalid variable name "${key}" (use A-Z, 0-9 and _)`);
    }
    out[key] = cleanString(value, 4000);
  }
  return out;
}

function botFields(input, { partial = false } = {}) {
  const out = {};

  if (!partial || input.name !== undefined) {
    const name = cleanString(input.name, 40).trim();
    if (!name) throw new HttpError(400, 'Bot name is required');
    out.name = name;
  }

  if (!partial || input.runtime !== undefined) {
    const runtime = cleanString(input.runtime || 'node', 20);
    if (!RUNTIMES.includes(runtime)) {
      throw new HttpError(400, `Runtime must be one of: ${RUNTIMES.join(', ')}`);
    }
    out.runtime = runtime;
  }

  if (!partial || input.entry !== undefined) {
    out.entry = validateEntry(input.entry);
  }

  if (input.args !== undefined) out.args = cleanString(input.args, 500);
  if (input.description !== undefined) out.description = cleanString(input.description, 300);
  if (input.env !== undefined) out.env = parseEnv(input.env);

  if (input.port !== undefined) {
    if (input.port === null || input.port === '' || Number(input.port) === 0) out.port = null;
    else {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be 1–65535');
      out.port = port;
    }
  }

  if (input.memoryLimitMB !== undefined) {
    const limit = Number(input.memoryLimitMB) || 0;
    if (limit < 0 || limit > 65536) throw new HttpError(400, 'Memory limit must be between 0 and 65536 MB');
    out.memoryLimitMB = Math.round(limit);
  }

  if (input.maxRestarts !== undefined) {
    const max = Number(input.maxRestarts);
    if (!Number.isInteger(max) || max < 0 || max > 1000) throw new HttpError(400, 'Max restarts must be 0–1000');
    out.maxRestarts = max;
  }

  if (input.autoRestart !== undefined) out.autoRestart = Boolean(input.autoRestart);
  if (input.autostart !== undefined) out.autostart = Boolean(input.autostart);

  return out;
}

function botOr404(ctx) {
  const bot = ctx.store.getBot(ctx.params.id);
  if (!bot) throw new HttpError(404, 'Bot not found');
  return bot;
}

async function botOverview(ctx, bot) {
  const usage = ctx.metrics.botUsage(ctx.supervisor.pids()).get(bot.id);
  return Object.assign(ctx.supervisor.serialize(bot), usage || { cpu: 0, mem: 0, processes: 0 });
}

module.exports = function registerRoutes(r, app) {
  const { cfg, store, supervisor, metrics, auth } = app;

  /* ----------------------------- auth -------------------------------- */

  r.get('/api/health', (ctx) => ctx.json({ ok: true, uptime: process.uptime() }));

  r.get('/api/auth/status', (ctx) =>
    ctx.json({
      setup: auth.needsSetup,
      panelName: store.settings.panelName,
      version: app.version || '1.0.0'
    })
  );

  r.post('/api/auth/setup', async (ctx) => {
    const body = await ctx.body();
    const token = await auth.setup(body.password);
    ctx.setSession(token);
    ctx.json({ token, panelName: store.settings.panelName });
  });

  r.post('/api/auth/login', async (ctx) => {
    const body = await ctx.body();
    const token = await auth.login(body.password, ctx.ip);
    ctx.setSession(token);
    ctx.json({ token, panelName: store.settings.panelName });
  });

  r.post('/api/auth/logout', (ctx) => {
    auth.destroy(ctx.token);
    ctx.clearSession();
    ctx.json({ ok: true });
  });

  r.get('/api/me', (ctx) =>
    ctx.json({
      authenticated: true,
      panelName: store.settings.panelName,
      hostname: require('os').hostname(),
      installedAt: store.settings.installedAt,
      lastLoginAt: store.settings.lastLoginAt
    })
  );

  r.post('/api/auth/password', async (ctx) => {
    const body = await ctx.body();
    const token = await auth.changePassword(body.current, body.next);
    ctx.setSession(token);
    ctx.json({ ok: true, token });
  });

  /* --------------------------- dashboard ----------------------------- */

  r.get('/api/overview', async (ctx) => {
    const bots = await Promise.all(store.bots.map((bot) => botOverview(ctx, bot)));
    const system = metrics.system();
    const counts = {
      total: bots.length,
      running: bots.filter((b) => b.status === 'running').length,
      stopped: bots.filter((b) => b.status === 'stopped').length,
      crashed: bots.filter((b) => b.status === 'crashed').length,
      restarting: bots.filter((b) => b.status === 'restarting').length
    };
    const botMem = bots.reduce((sum, b) => sum + (b.mem || 0), 0);
    ctx.json({
      bots,
      counts,
      system,
      botMemory: botMem,
      dirs: { bots: cfg.BOTS_DIR, data: cfg.DATA_DIR },
      panelName: store.settings.panelName
    });
  });

  /* ------------------------------ bots ------------------------------- */

  r.get('/api/bots', async (ctx) => {
    const bots = await Promise.all(store.bots.map((bot) => botOverview(ctx, bot)));
    ctx.json({ bots });
  });

  r.post('/api/bots', async (ctx) => {
    const input = await ctx.body();
    const fields = botFields(input);
    if (store.bots.some((b) => b.name.toLowerCase() === fields.name.toLowerCase())) {
      throw new HttpError(409, 'A bot with this name already exists');
    }
    const runtime = fields.runtime;
    const template = TEMPLATES[runtime];
    const id = uid('bot');
    const dir = supervisor.botDir(id);
    await fsp.mkdir(dir, { recursive: true });

    const entry = fields.entry || template.file;
    if (input.template !== false && template) {
      const target = safeJoin(dir, template.file);
      try {
        await fsp.access(target);
      } catch (_) {
        await fsp.writeFile(target, template.body(fields.name), { mode: template.mode });
      }
    }

    const now = Date.now();
    const bot = {
      id,
      name: fields.name,
      runtime,
      entry,
      args: fields.args || '',
      env: fields.env || {},
      port: fields.port || null,
      description: fields.description || '',
      autoRestart: fields.autoRestart !== undefined ? fields.autoRestart : true,
      maxRestarts: fields.maxRestarts !== undefined ? fields.maxRestarts : 10,
      autostart: Boolean(fields.autostart),
      memoryLimitMB: fields.memoryLimitMB || 0,
      createdAt: now,
      updatedAt: now,
      totalRuns: 0,
      lastExit: null
    };
    store.addBot(bot);
    supervisor.sys(id, `Bot created — runtime: ${runtime}, entry: ${entry}`);
    supervisor.sys(id, `Working folder: ${dir}`);

    if (input.start) {
      try {
        await supervisor.start(id);
      } catch (err) {
        supervisor.sys(id, `Start failed: ${err.message}`);
      }
    }

    ctx.json({ bot: await botOverview(ctx, bot) }, 201);
  });

  // bulk actions must be declared before /:id routes
  r.post('/api/bots/actions', async (ctx) => {
    const body = await ctx.body();
    const action = String(body.action || '');
    if (!['start-all', 'stop-all', 'restart-all'].includes(action)) {
      throw new HttpError(400, 'Unknown bulk action');
    }
    const results = { ok: 0, failed: 0 };
    for (const bot of store.bots) {
      try {
        if (action === 'start-all') {
          if (supervisor.state(bot.id).status === 'running') continue;
          await supervisor.start(bot.id);
        } else if (action === 'stop-all') {
          await supervisor.stop(bot.id);
        } else {
          await supervisor.restart(bot.id);
        }
        results.ok++;
      } catch (_) {
        results.failed++;
      }
    }
    ctx.json(results);
  });

  r.get('/api/bots/:id', async (ctx) => {
    const bot = botOr404(ctx);
    ctx.json({ bot: await botOverview(ctx, bot), dir: supervisor.botDir(bot.id) });
  });

  r.patch('/api/bots/:id', async (ctx) => {
    const bot = botOr404(ctx);
    const input = await ctx.body();
    const patch = botFields(input, { partial: true });
    if (patch.name && patch.name.toLowerCase() !== bot.name.toLowerCase()) {
      if (store.bots.some((b) => b.id !== bot.id && b.name.toLowerCase() === patch.name.toLowerCase())) {
        throw new HttpError(409, 'Another bot already uses this name');
      }
    }
    if (patch.runtime && patch.runtime !== bot.runtime && input.entry === undefined) {
      const template = TEMPLATES[patch.runtime];
      if (template) patch.entry = template.file;
    }
    const updated = store.updateBot(bot.id, patch);
    supervisor.sys(bot.id, 'Configuration updated');
    ctx.json({ bot: await botOverview(ctx, updated) });
  });

  r.post('/api/bots/:id/clone', async (ctx) => {
    const source = botOr404(ctx);
    const body = await ctx.body();
    const wanted = cleanString(body.name, 40).trim() || `${source.name} copy`;
    let name = wanted;
    let suffix = 2;
    while (store.bots.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
      name = `${wanted} ${suffix++}`.slice(0, 40);
    }

    const id = uid('bot');
    const dir = supervisor.botDir(id);
    await fsp.mkdir(dir, { recursive: true });
    try {
      await fsp.cp(supervisor.botDir(source.id), dir, { recursive: true, force: true });
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(500, `Could not copy bot files: ${err.message}`);
    }

    const now = Date.now();
    const clone = {
      id,
      name,
      runtime: source.runtime,
      entry: source.entry,
      args: source.args || '',
      env: JSON.parse(JSON.stringify(source.env || {})),
      port: null,
      description: source.description || '',
      autoRestart: source.autoRestart !== false,
      maxRestarts: source.maxRestarts ?? 10,
      autostart: false,
      memoryLimitMB: source.memoryLimitMB || 0,
      createdAt: now,
      updatedAt: now,
      totalRuns: 0,
      lastExit: null,
      lastStartedAt: null
    };
    store.addBot(clone);
    supervisor.sys(id, `Cloned from "${source.name}"`);
    supervisor.sys(id, `Working folder: ${dir}`);
    ctx.json({ bot: await botOverview(ctx, clone) }, 201);
  });

  r.delete('/api/bots/:id', async (ctx) => {
    const bot = botOr404(ctx);
    const deleteFiles = ctx.query.get('files') === '1' || ctx.query.get('files') === 'true';
    const dir = supervisor.botDir(bot.id);
    await supervisor.remove(bot.id);
    store.removeBot(bot.id);
    if (deleteFiles) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    ctx.json({ ok: true, deletedFiles: deleteFiles });
  });

  r.post('/api/bots/:id/input', async (ctx) => {
    const bot = botOr404(ctx);
    const body = await ctx.body();
    supervisor.sendInput(bot.id, String(body.data ?? ''));
    ctx.json({ ok: true });
  });

  r.post('/api/bots/:id/:action', async (ctx) => {
    const bot = botOr404(ctx);
    const action = ctx.params.action;
    if (!ACTIONS.has(action)) throw new HttpError(404, 'Unknown action');

    if (action === 'start') {
      const result = await supervisor.start(bot.id, { byUser: true });
      return ctx.json({ ok: true, ...result });
    }
    if (action === 'stop') {
      const result = await supervisor.stop(bot.id);
      return ctx.json(result);
    }
    if (action === 'kill') {
      const result = await supervisor.stop(bot.id, { force: true });
      return ctx.json(result);
    }
    const result = await supervisor.restart(bot.id);
    return ctx.json({ ok: true, ...result });
  });

  /* ------------------------------ logs ------------------------------- */

  r.get('/api/bots/:id/logs', async (ctx) => {
    const bot = botOr404(ctx);
    const lines = Math.min(Math.max(Number(ctx.query.get('lines')) || 300, 10), 2000);
    const entries = await supervisor.tailLogs(bot.id, lines);
    ctx.json({ logs: entries, status: supervisor.serialize(bot).status });
  });

  r.delete('/api/bots/:id/logs', (ctx) => {
    const bot = botOr404(ctx);
    supervisor.clearLogs(bot.id);
    ctx.json({ ok: true });
  });

  r.get('/api/bots/:id/logs/download', async (ctx) => {
    const bot = botOr404(ctx);
    const file = supervisor.logPath(bot.id);
    let stat = null;
    try {
      stat = await fsp.stat(file);
    } catch (_) {
      /* no logs */
    }
    if (!stat || !stat.size) throw new HttpError(404, 'No logs yet');
    const safeName = attachmentName(bot.name, 'bot');
    ctx.res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}.log"`,
      'Content-Length': stat.size
    });
    fs.createReadStream(file).pipe(ctx.res);
  });

  r.get('/api/bots/:id/stream', (ctx) => {
    const bot = botOr404(ctx);
    const { res, req } = ctx;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');

    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const state = supervisor.state(bot.id);
    send('status', { status: state.status, pid: state.pid, restarts: state.restarts });

    const onLog = (payload) => {
      if (payload.id === bot.id) send('log', payload.entry);
    };
    const onStatus = (payload) => {
      if (payload.id === bot.id) send('status', payload);
    };

    supervisor.on('log', onLog);
    supervisor.on('status', onStatus);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 20000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      supervisor.removeListener('log', onLog);
      supervisor.removeListener('status', onStatus);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  /* ------------------------------ files ------------------------------ */

  r.get('/api/bots/:id/files', async (ctx) => {
    const bot = botOr404(ctx);
    const root = supervisor.botDir(bot.id);
    await fsp.mkdir(root, { recursive: true });
    const result = await files.listDir(root, ctx.query.get('path') || '');
    ctx.json(result);
  });

  r.get('/api/bots/:id/files/read', async (ctx) => {
    const bot = botOr404(ctx);
    const rel = ctx.query.get('path');
    if (!rel) throw new HttpError(400, 'path is required');
    ctx.json(await files.readFile(supervisor.botDir(bot.id), rel, cfg.MAX_EDIT_BYTES));
  });

  r.put('/api/bots/:id/files/write', async (ctx) => {
    const bot = botOr404(ctx);
    const rel = ctx.query.get('path');
    if (!rel) throw new HttpError(400, 'path is required');
    const body = await ctx.body();
    if (typeof body.content !== 'string') throw new HttpError(400, 'content must be a string');
    if (Buffer.byteLength(body.content) > cfg.MAX_EDIT_BYTES) throw new HttpError(413, 'File is too large');
    ctx.json(await files.writeFile(supervisor.botDir(bot.id), rel, body.content));
  });

  r.put(
    '/api/bots/:id/files/upload',
    async (ctx) => {
      const bot = botOr404(ctx);
      const dir = ctx.query.get('path') || '';
      const name = ctx.query.get('name');
      if (!name) throw new HttpError(400, 'name is required');
      const result = await files.saveUpload(
        supervisor.botDir(bot.id),
        dir,
        name,
        ctx.req,
        cfg.MAX_UPLOAD_BYTES
      );
      supervisor.sys(bot.id, `Uploaded ${result.path} (${formatBytes(result.size)})`);
      ctx.json(result);
    },
    { raw: true }
  );

  r.get('/api/bots/:id/files/download', async (ctx) => {
    const bot = botOr404(ctx);
    const rel = ctx.query.get('path');
    if (!rel) throw new HttpError(400, 'path is required');
    const root = supervisor.botDir(bot.id);
    const target = safeJoin(root, rel);
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat) throw new HttpError(404, 'File not found');
    if (stat.isDirectory()) throw new HttpError(400, 'Cannot download a folder');
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${attachmentName(path.basename(target))}"`,
      'Content-Length': stat.size
    });
    fs.createReadStream(target).pipe(ctx.res);
  });

  r.post('/api/bots/:id/files/mkdir', async (ctx) => {
    const bot = botOr404(ctx);
    const body = await ctx.body();
    ctx.json(await files.mkdir(supervisor.botDir(bot.id), body.path));
  });

  r.post('/api/bots/:id/files/rename', async (ctx) => {
    const bot = botOr404(ctx);
    const body = await ctx.body();
    ctx.json(await files.rename(supervisor.botDir(bot.id), body.from, body.to));
  });

  r.post('/api/bots/:id/files/delete', async (ctx) => {
    const bot = botOr404(ctx);
    const body = await ctx.body();
    const result = await files.remove(supervisor.botDir(bot.id), body.path);
    supervisor.sys(bot.id, `Deleted ${body.path}`);
    ctx.json(result);
  });

  r.post('/api/bots/:id/files/extract', async (ctx) => {
    const bot = botOr404(ctx);
    const body = await ctx.body();
    const result = await files.extract(supervisor.botDir(bot.id), body.path);
    supervisor.sys(bot.id, `Extracted ${body.path}`);
    ctx.json(result);
  });

  /* ---------------------------- settings ----------------------------- */

  r.get('/api/settings', (ctx) =>
    ctx.json({
      panelName: store.settings.panelName,
      botsDir: cfg.BOTS_DIR,
      dataDir: cfg.DATA_DIR,
      port: cfg.PORT,
      logMaxBytes: cfg.LOG_MAX_BYTES,
      node: process.version,
      uptime: process.uptime()
    })
  );

  r.patch('/api/settings', async (ctx) => {
    const body = await ctx.body();
    if (body.panelName !== undefined) {
      const name = cleanString(body.panelName, 40).trim();
      if (!name) throw new HttpError(400, 'Panel name cannot be empty');
      store.settings.panelName = name;
      await store.save(true);
    }
    ctx.json({ ok: true, panelName: store.settings.panelName });
  });
};
