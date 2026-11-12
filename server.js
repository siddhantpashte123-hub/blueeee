'use strict';

/**
 * BotDeck — a Docker-free bot hosting panel.
 *
 * Runs every bot as a plain child process on the VPS (no containers, no
 * orchestration, no external services). Single Node process, zero npm
 * dependencies.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const cfg = require('./src/config');
const Store = require('./src/store');
const Metrics = require('./src/metrics');
const Supervisor = require('./src/supervisor');
const Auth = require('./src/auth');
const Router = require('./src/router');
const { HttpError, safeJoin } = require('./src/util');
const registerRoutes = require('./src/routes');

const COOKIE_NAME = 'bd_session';
const VERSION = '1.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/* ------------------------------ helpers -------------------------------- */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function serveFile(res, filePath, req, { cache = 'no-cache' } = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

/* ------------------------------- app ----------------------------------- */

function createApp({ store, supervisor, metrics, auth }) {
  const router = new Router();
  registerRoutes(router, { cfg, store, supervisor, metrics, auth, version: VERSION });

  const indexFile = path.join(cfg.PUBLIC_DIR, 'index.html');

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Robots-Tag', 'noindex');

    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
      return sendJson(res, 400, { error: 'Bad request' });
    }

    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch (_) {
      /* keep raw */
    }
    pathname = pathname.replace(/\/{2,}/g, '/');

    /* -------------------------- static files -------------------------- */

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      if (pathname.startsWith('/assets/')) {
        let filePath;
        try {
          filePath = safeJoin(cfg.PUBLIC_DIR, pathname);
        } catch (_) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        const served = await serveFile(res, filePath, req, { cache: 'public, max-age=300' });
        if (!served) return sendJson(res, 404, { error: 'Not found' });
        return undefined;
      }
      if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
        const served = await serveFile(res, path.join(cfg.PUBLIC_DIR, 'assets', 'favicon.svg'), req, {
          cache: 'public, max-age=86400'
        });
        if (!served) {
          res.writeHead(204).end();
        }
        return undefined;
      }
      // Single page app shell for everything else.
      const served = await serveFile(res, indexFile, req, { cache: 'no-store' });
      if (!served) return sendJson(res, 500, { error: 'Panel UI is missing (public/index.html)' });
      return undefined;
    }

    /* ----------------------------- api -------------------------------- */

    const cookies = parseCookies(req);
    const bearer = bearerToken(req);
    let token = bearer || cookies[COOKIE_NAME] || null;
    if (!token) token = url.searchParams.get('token');

    const publicPaths = new Set([
      '/api/health',
      '/api/auth/status',
      '/api/auth/login',
      '/api/auth/setup'
    ]);
    const isPublic = publicPaths.has(pathname);
    const authenticated = auth.checkToken(token);

    if (!isPublic && !authenticated) {
      return sendJson(res, 401, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    // Basic CSRF protection for cookie-authenticated state changing calls.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !bearer) {
      const origin = req.headers.origin;
      if (origin) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch (_) {
          /* ignore */
        }
        if (originHost && originHost !== req.headers.host) {
          return sendJson(res, 403, { error: 'Cross-origin request blocked' });
        }
      }
    }

    const ctx = {
      req,
      res,
      method: req.method,
      url,
      pathname,
      query: url.searchParams,
      params: {},
      ip: clientIp(req),
      token,
      cfg,
      store,
      supervisor,
      metrics,
      auth,
      rawBody: false,
      _data: undefined,
      json(payload, status = 200) {
        return sendJson(res, status, payload);
      },
      async body() {
        if (ctx._data !== undefined) return ctx._data;
        const raw = await readBody(req, cfg.MAX_JSON_BODY);
        let parsed = {};
        if (raw && raw.trim()) {
          try {
            parsed = JSON.parse(raw);
          } catch (_) {
            throw new HttpError(400, 'Invalid JSON body');
          }
        }
        ctx._data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        return ctx._data;
      },
      setSession(newToken) {
        ctx.token = newToken;
        const maxAge = Math.floor(cfg.SESSION_TTL / 1000);
        const secure =
          req.socket && req.socket.encrypted
            ? '; Secure'
            : String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
              ? '; Secure'
              : '';
        res.setHeader(
          'Set-Cookie',
          `${COOKIE_NAME}=${encodeURIComponent(newToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
        );
      },
      clearSession() {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      }
    };

    const handled = await router.dispatch(ctx);
    if (!handled && !res.headersSent && !res.writableEnded) {
      sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
    }
    return undefined;
  }

  return async function requestListener(req, res) {
    try {
      await handle(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err.statusCode || 500;
      if (status >= 500) console.error(`[api] ${req.method} ${req.url} →`, err);
      if (res.headersSent) {
        try {
          res.destroy();
        } catch (_) {
          /* ignore */
        }
        return;
      }
      sendJson(res, status, { error: err.message || 'Internal server error' });
    }
  };
}

/* ------------------------------ bootstrap ------------------------------ */

async function main() {
  await fsp.mkdir(cfg.DATA_DIR, { recursive: true });
  await fsp.mkdir(cfg.LOGS_DIR, { recursive: true });
  await fsp.mkdir(cfg.BOTS_DIR, { recursive: true });

  const store = new Store(cfg.STORE_FILE).load();
  const metrics = new Metrics(store, cfg);
  const supervisor = new Supervisor(store, cfg, metrics);
  const auth = new Auth(store, cfg);

  // Allow unattended installs: BOTDECK_PASSWORD=... npm start
  if (process.env.BOTDECK_PASSWORD && auth.needsSetup) {
    const password = process.env.BOTDECK_PASSWORD;
    if (password.length >= 8) {
      await auth.setup(password);
      console.log('[panel] admin password initialised from BOTDECK_PASSWORD');
    } else {
      console.warn('[panel] BOTDECK_PASSWORD must be at least 8 characters — ignored');
    }
  }

  const app = createApp({ store, supervisor, metrics, auth });
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[panel] port ${cfg.PORT} is already in use. Set PORT to something else.\n`);
      process.exit(1);
    }
    console.error('[panel] server error:', err);
  });

  server.listen(cfg.PORT, cfg.HOST, async () => {
    const line = '─'.repeat(56);
    console.log(`\n┌${line}┐`);
    console.log(`│  BotDeck v${VERSION} — Docker-free bot hosting panel`.padEnd(57) + '│');
    console.log(`├${line}┤`);
    console.log(`│  URL      : http://${cfg.HOST}:${cfg.PORT}`.padEnd(57) + '│');
    console.log(`│  Bots     : ${cfg.BOTS_DIR}`.padEnd(57) + '│');
    console.log(`│  Data     : ${cfg.DATA_DIR}`.padEnd(57) + '│');
    console.log(`│  Setup    : ${auth.needsSetup ? 'open the panel to create a password' : 'password set'}`.padEnd(57) + '│');
    console.log(`└${line}┘\n`);

    if (process.platform !== 'linux') {
      console.warn('[panel] warning: process metrics use Linux /proc — other platforms get limited stats');
    }

    await supervisor.cleanupOrphans();
    supervisor.startWatchdog();
    await supervisor.autostart();
  });

  const shutdown = async (signal) => {
    console.log(`\n[panel] ${signal} received — stopping bots and exiting…`);
    server.close();
    try {
      await supervisor.shutdown();
      await store.save(true);
    } catch (err) {
      console.error('[panel] shutdown error:', err.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => console.error('[panel] uncaught exception:', err));
  process.on('unhandledRejection', (err) => console.error('[panel] unhandled rejection:', err));

  return { server, store, supervisor, auth };
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[panel] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createApp, main, VERSION };
