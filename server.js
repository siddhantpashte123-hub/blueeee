'use strict';
/**
 * Forge — local AI code studio. Ek Node process, koi npm dependency nahi.
 * Panel :4040 par, engine (llama-server) andar 127.0.0.1:4055 par.
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
const llm = require('./src/llm');
const models = require('./src/models');
const project = require('./src/project');
const { ensureDir, memInfo, fmtBytes } = require('./src/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) return false;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': path.extname(abs) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(abs).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function banner(engine) {
  const mem = memInfo();
  const cols = (s) => `\x1b[36m${s}\x1b[0m`;
  console.log(
    [
      '',
      `  ${cols('╔════════════════════════════════════════════╗')}`,
      `  ${cols('║')}  \x1b[1mFORGE\x1b[0m — local AI code studio             ${cols('║')}`,
      `  ${cols('╚════════════════════════════════════════════╝')}`,
      `  Panel    : http://localhost:${cfg.PORT}`,
      `  Engine   : ${engine.mode === 'external' ? cfg.LLM_URL : engine.bin || 'llama-server NOT FOUND'}`,
      `  Model    : ${llm.state.modelName || (store.get().settings.modelId ? '(load ho raha hai)' : 'koi model load nahi')}`,
      `  RAM      : ${fmtBytes(mem.free)} free / ${fmtBytes(mem.total)}`,
      `  Threads  : ${cfg.THREADS}  ·  ctx ${cfg.CTX_SIZE}`,
      `  Workspace: ${cfg.WORKSPACE_DIR}`,
      `  First run: ${auth.needsSetup() ? 'YES — password set karein' : 'no'}`,
      ''
    ].join('\n')
  );
  if (!engine.bin && engine.mode === 'local') {
    console.log('  \x1b[33m⚠ llama-server nahi mila. Installer chalayein:\x1b[0m sudo bash scripts/install.sh\n');
  }
}

async function main() {
  for (const d of [cfg.DATA_DIR, cfg.MODELS_DIR, cfg.CHATS_DIR, cfg.BIN_DIR, cfg.WORKSPACE_DIR]) await ensureDir(d);
  await store.init();
  await project.init();
  await models.refreshFromDisk();

  const server = { router: new Router() };
  routes.build(server);

  const httpServer = http.createServer(async (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
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
        else {
          try {
            res.end();
          } catch {}
        }
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    if (await serveStatic(req, res, pathname)) return;
    if (!path.extname(pathname)) {
      try {
        const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(html);
      } catch {}
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  });

  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.keepAliveTimeout = 65000;

  httpServer.listen(cfg.PORT, cfg.HOST, async () => {
    const engine = await llm.engineInfo();
    banner(engine);
    // model pehle se selected hai to background me load karo
    llm.autostart().catch((e) => console.error('[engine]', e.message));
  });

  const shutdown = async (sig) => {
    console.log(`\n[panel] ${sig} — band ho raha hoon`);
    llm.stopAll();
    try {
      await llm.stop();
    } catch {}
    try {
      await store.save();
    } catch {}
    httpServer.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message));
  process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack));
}

main().catch((e) => {
  console.error('Panel start nahi hua:', e);
  process.exit(1);
});
