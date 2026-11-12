'use strict';
/**
 * VPSDeck — panel entrypoint.
 * Ek hi Node process: HTTP server + QEMU orchestration. Koi npm dependency nahi.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cfg = require('./src/config');
const store = require('./src/store');
const auth = require('./src/auth');
const Router = require('./src/router');
const routes = require('./src/routes');
const vms = require('./src/vms');
const qemu = require('./src/qemu');
const serial = require('./src/serial');
const { ensureDir } = require('./src/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) return false;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return false;
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(abs).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function banner(port, e) {
  const mode = e && e.kvm ? 'KVM (hardware accel)' : 'TCG (software mode — slow but works)';
  const setup = auth.needsSetup() ? 'YES — pehli baar password set karein' : 'no';
  const lines = [
    '',
    '  \x1b[36m╔══════════════════════════════════════════╗\x1b[0m',
    '  \x1b[36m║\x1b[0m  \x1b[1mVPSDeck\x1b[0m — apna VPS ke andar VPS        \x1b[36m║\x1b[0m',
    '  \x1b[36m╚══════════════════════════════════════════╝\x1b[0m',
    `  Panel      : http://${cfg.HOST === '0.0.0.0' ? 'localhost' : cfg.HOST}:${port}`,
    `  Data dir   : ${cfg.DATA_DIR}`,
    `  QEMU       : ${e && e.version ? e.version : 'NOT FOUND'}`,
    `  Accel      : ${mode}`,
    `  First run  : ${setup}`,
    ''
  ];
  console.log(lines.join('\n'));
  if (!e || !e.ready) {
    console.log(
      '  \x1b[33m⚠ QEMU install nahi hai. Chalao:\x1b[0m sudo apt install -y qemu-system-x86 qemu-utils\n'
    );
  } else if (!e.kvm) {
    console.log(
      '  \x1b[33m⚠ /dev/kvm nahi mila — VMs software mode me chalenge (slow).\n' +
        '    Hosting provider se "nested virtualization" on karwayein to 10x fast ho jayega.\x1b[0m\n'
    );
  }
}

async function main() {
  await ensureDir(cfg.DATA_DIR);
  for (const d of [cfg.VMS_DIR, cfg.IMAGES_DIR, cfg.LOG_DIR]) await ensureDir(d);
  await store.init();

  const server = {
    router: new Router()
  };
  routes.build(server);

  const httpServer = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      const u = new URL(req.url, 'http://localhost');
      pathname = u.pathname;
    } catch {}

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (pathname.startsWith('/api/')) {
      const m = server.router.match(req.method, pathname);
      if (!m) return routes.json(res, 404, { error: 'API nahi mila' });
      try {
        await m.handler(req, res, { params: m.params });
      } catch (e) {
        if (!res.headersSent) routes.fail(res, e);
        else res.end();
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('Method not allowed');
    }

    if (await serveStatic(req, res, pathname)) return;

    // SPA fallback
    if (!path.extname(pathname)) {
      try {
        const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(html);
      } catch {}
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — page nahi mila');
  });

  httpServer.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {}
  });

  httpServer.listen(cfg.PORT, cfg.HOST, async () => {
    const e = await qemu.env();
    banner(cfg.PORT, e);
    if (e.ready) {
      // pehle se chal rahe VMs se judo + autostart
      vms.boot().catch((err) => console.error('[boot]', err.message));
    }
  });

  const shutdown = async (sig) => {
    console.log(`\n[panel] ${sig} mila — band ho raha hoon (VMs chalte rahenge)`);
    try {
      await store.flush();
    } catch {}
    serial.dropAll();
    httpServer.close();
    setTimeout(() => process.exit(0), 400);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err && err.message ? err.message : err);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  });
}

main().catch((err) => {
  console.error('Panel start nahi hua:', err);
  process.exit(1);
});
