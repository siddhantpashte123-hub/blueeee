'use strict';
/**
 * HTTP API. Har route yahin hai — server.js sirf wiring karta hai.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const cfg = require('./config');
const store = require('./store');
const auth = require('./auth');
const vms = require('./vms');
const qemu = require('./qemu');
const images = require('./images');
const packageJson = require('../package.json');

// ---------- helpers ----------
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

async function body(req, limit = cfg.MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
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

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isSecure(req) {
  return (
    !!req.socket.encrypted ||
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
  );
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = String(req.headers.host || '');
    return o.host === host;
  } catch {
    return false;
  }
}

// ---------- routes ----------
function build(server) {
  const r = server.router;

  // ---- public ----
  r.get('/api/health', async (req, res) => {
    const e = await qemu.env();
    json(res, 200, {
      ok: true,
      name: 'VPSDeck',
      version: packageJson.version,
      setupNeeded: auth.needsSetup(),
      qemu: !!e.qemuBin,
      qemuImg: !!e.qemuImg,
      kvm: e.kvm,
      accel: e.kvm ? 'kvm' : 'tcg'
    });
  });

  r.get('/api/auth/state', async (req, res) => {
    const s = auth.sessionFromReq(req);
    json(res, 200, { needsSetup: auth.needsSetup(), authed: !!s, user: s ? s.user : null });
  });

  r.post('/api/auth/setup', async (req, res) => {
    try {
      if (!auth.needsSetup()) throw Object.assign(new Error('Panel pehle se set hai'), { status: 409 });
      const b = await body(req);
      await auth.setPassword(b.password);
      const token = auth.createSession('admin', clientIp(req));
      res.setHeader('Set-Cookie', auth.sessionCookie(token, isSecure(req)));
      json(res, 200, { ok: true, user: 'admin' });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/api/auth/login', async (req, res) => {
    try {
      const ip = clientIp(req);
      if (auth.rateLimited(ip)) {
        throw Object.assign(new Error('Bahut zyada galat koshish — 5 minute baad try karein'), { status: 429 });
      }
      const b = await body(req);
      const st = store.get();
      const ok = st.auth && auth.verifyPassword(b.password, st.auth.hash);
      if (!ok) {
        auth.bumpTry(ip);
        throw Object.assign(new Error('Galat password'), { status: 401 });
      }
      auth.clearTries(ip);
      const token = auth.createSession(st.auth.user || 'admin', ip);
      res.setHeader('Set-Cookie', auth.sessionCookie(token, isSecure(req)));
      json(res, 200, { ok: true, user: st.auth.user || 'admin' });
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

  // ---- public console (friend share link) ----
  r.get('/api/public/console/:token', async (req, res, ctx) => {
    const vm = (store.get().vms || []).find((v) => v.shareToken === ctx.params.token);
    if (!vm) return json(res, 404, { error: 'Link valid nahi hai' });
    await consoleStream(req, res, vm, { writable: true });
  });

  r.post('/api/public/console/:token', async (req, res, ctx) => {
    const vm = (store.get().vms || []).find((v) => v.shareToken === ctx.params.token);
    if (!vm) return json(res, 404, { error: 'Link valid nahi hai' });
    return consoleInput(req, res, vm);
  });

  // ---- everything else needs login ----
  const guard = (handler) => async (req, res, ctx) => {
    const s = auth.sessionFromReq(req);
    if (!s) return json(res, 401, { error: 'Login karein' });
    if (req.method !== 'GET' && !sameOrigin(req)) {
      return json(res, 403, { error: 'Bad origin' });
    }
    ctx.session = s;
    try {
      await handler(req, res, ctx);
    } catch (e) {
      fail(res, e);
    }
  };

  r.get('/api/system', guard(async (req, res) => {
    const e = await qemu.env({ refresh: true });
    json(res, 200, {
      version: packageJson.version,
      node: process.version,
      host: os.hostname(),
      uptime: process.uptime(),
      cpus: os.cpus().length,
      load: require('./util').hostLoad(),
      mem: { total: os.totalmem(), free: os.freemem() },
      qemu: { bin: e.qemuBin, img: e.qemuImg, version: e.version, kvm: e.kvm, kvmReason: e.kvmReason },
      accel: e.kvm ? 'kvm' : 'tcg',
      settings: store.get().settings || {},
      stats: await vms.stats(),
      x86: process.arch
    });
  }));

  r.post('/api/settings', guard(async (req, res) => {
    const b = await body(req);
    const patch = {};
    if (b.sshHost !== undefined) patch.sshHost = String(b.sshHost).trim().slice(0, 120);
    if (b.panelName !== undefined) patch.panelName = String(b.panelName).trim().slice(0, 60);
    if (b.tunnelHint !== undefined) patch.tunnelHint = String(b.tunnelHint).slice(0, 200);
    await store.update((s) => {
      s.settings = Object.assign({}, s.settings, patch);
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
    const token = auth.createSession('admin', clientIp(req));
    res.setHeader('Set-Cookie', auth.sessionCookie(token, isSecure(req)));
    json(res, 200, { ok: true });
  }));

  // ---- vms ----
  r.get('/api/vms', guard(async (req, res) => {
    json(res, 200, { vms: await vms.list() });
  }));

  r.post('/api/vms', guard(async (req, res) => {
    const b = await body(req);
    const vm = await vms.create(b);
    json(res, 201, { vm });
  }));

  r.get('/api/vms/:id', guard(async (req, res, ctx) => {
    const vm = await vms.get(ctx.params.id);
    json(res, 200, { vm });
  }));

  r.patch('/api/vms/:id', guard(async (req, res, ctx) => {
    const b = await body(req);
    json(res, 200, { vm: await vms.update(ctx.params.id, b) });
  }));

  r.delete('/api/vms/:id', guard(async (req, res, ctx) => {
    json(res, 200, await vms.remove(ctx.params.id));
  }));

  r.post('/api/vms/:id/start', guard(async (req, res, ctx) => {
    json(res, 200, { vm: await vms.start(ctx.params.id) });
  }));

  r.post('/api/vms/:id/stop', guard(async (req, res, ctx) => {
    await vms.stop(ctx.params.id);
    json(res, 200, { ok: true, vm: await vms.get(ctx.params.id, { fresh: true }) });
  }));

  r.post('/api/vms/:id/restart', guard(async (req, res, ctx) => {
    json(res, 200, { vm: await vms.restart(ctx.params.id) });
  }));

  r.post('/api/vms/:id/reinstall', guard(async (req, res, ctx) => {
    json(res, 200, { vm: await vms.reinstall(ctx.params.id) });
  }));

  r.post('/api/vms/:id/clone', guard(async (req, res, ctx) => {
    const b = await body(req).catch(() => ({}));
    json(res, 201, { vm: await vms.clone(ctx.params.id, b) });
  }));

  r.post('/api/vms/:id/resize', guard(async (req, res, ctx) => {
    const b = await body(req);
    json(res, 200, { vm: await vms.resize(ctx.params.id, b.diskGB) });
  }));

  r.get('/api/vms/:id/ssh', guard(async (req, res, ctx) => {
    const vm = await vms.get(ctx.params.id);
    const st = store.get().settings || {};
    const ip = st.sshHost || req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const hostOnly = String(ip).split(':')[0];
    json(res, 200, {
      host: hostOnly,
      port: vm.sshPort,
      user: vm.user,
      password: vm.password,
      command: `ssh -p ${vm.sshPort} ${vm.user}@${hostOnly}`,
      note: 'Port sirf VPS ke localhost par khula hai — laptop se seedha connect karne ke liye tunnel chahiye.'
    });
  }));

  // ---- snapshots ----
  r.get('/api/vms/:id/snapshots', guard(async (req, res, ctx) => {
    json(res, 200, { snapshots: await vms.snapshots(ctx.params.id) });
  }));

  r.post('/api/vms/:id/snapshots', guard(async (req, res, ctx) => {
    const b = await body(req);
    json(res, 200, await vms.snapshotCreate(ctx.params.id, b.tag));
  }));

  r.post('/api/vms/:id/snapshots/:tag/restore', guard(async (req, res, ctx) => {
    json(res, 200, await vms.snapshotRestore(ctx.params.id, ctx.params.tag));
  }));

  r.delete('/api/vms/:id/snapshots/:tag', guard(async (req, res, ctx) => {
    json(res, 200, await vms.snapshotDelete(ctx.params.id, ctx.params.tag));
  }));

  // ---- console ----
  r.get('/api/vms/:id/console', guard(async (req, res, ctx) => {
    const vm = vms.find(ctx.params.id);
    if (!vm) return json(res, 404, { error: 'VM nahi mila' });
    await consoleStream(req, res, vm, { writable: true });
  }));

  r.post('/api/vms/:id/console', guard(async (req, res, ctx) => {
    const vm = vms.find(ctx.params.id);
    if (!vm) return json(res, 404, { error: 'VM nahi mila' });
    return consoleInput(req, res, vm);
  }));

  // ---- images ----
  r.get('/api/images', guard(async (req, res) => {
    json(res, 200, images.list());
  }));

  r.post('/api/images/download', guard(async (req, res) => {
    const b = await body(req);
    const p = await images.download(b.id || b.url, { url: b.url, name: b.name, user: b.user });
    json(res, 202, { ok: true, download: p });
  }));

  r.delete('/api/images/:id', guard(async (req, res, ctx) => {
    json(res, 200, await images.remove(ctx.params.id));
  }));

  // raw upload: body = file bytes, ?name=file.iso
  r.post('/api/images/upload', guard(async (req, res, ctx) => {
    const name = ctx.params.name || new URL(req.url, 'http://x').searchParams.get('name') || 'upload.iso';
    const img = await images.saveUpload(name, req);
    json(res, 201, { image: img });
  }));

  // ---- misc ----
  r.get('/api/images/progress', guard(async (req, res) => {
    json(res, 200, { downloads: images.list().catalog });
  }));

  return r;
}

// ---------- console plumbing ----------
async function consoleStream(req, res, vm, { writable }) {
  const st = await qemu.status(vm);
  if (!st.running) {
    return json(res, 409, { error: 'VM band hai — pehle start karein' });
  }
  let bridge;
  try {
    bridge = await vms.consoleConnect(vm.id);
  } catch (e) {
    return json(res, 502, { error: `Serial console se connect nahi hua: ${e.message}` });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ id: vm.id, name: vm.name, writable })}\n\n`);
  const snap = bridge.snapshot();
  if (snap) res.write(`data: ${JSON.stringify({ out: snap })}\n\n`);

  const onData = (chunk) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ out: chunk })}\n\n`);
  };
  bridge.on('data', onData);
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    bridge.removeListener('data', onData);
  });
}

async function consoleInput(req, res, vm) {
  const b = await body(req, 64 * 1024);
  const data = String(b.data || '');
  if (!data) return json(res, 400, { error: 'data khali hai' });
  const bridge = vms.consoleBridge(vm.id);
  if (!bridge.connected) return json(res, 409, { error: 'Console disconnect hai' });
  bridge.write(data);
  json(res, 200, { ok: true });
}

module.exports = { build, json, fail, body };
