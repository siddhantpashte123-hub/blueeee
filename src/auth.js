'use strict';
/** Password (scrypt) + in-memory sessions. NO_AUTH=1 se bilkul band. */
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');

const sessions = new Map();
const tries = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const p = String(stored || '').split('$');
    const salt = Buffer.from(p[4], 'base64');
    const want = Buffer.from(p[5], 'base64');
    const got = crypto.scryptSync(String(password), salt, want.length, {
      N: parseInt(p[1], 10) || 16384,
      r: parseInt(p[2], 10) || 8,
      p: parseInt(p[3], 10) || 1
    });
    return crypto.timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

function needsSetup() {
  if (cfg.NO_AUTH) return false;
  const st = store.get();
  return !st.auth || !st.auth.hash;
}

async function setPassword(password, user = 'admin') {
  const pw = String(password || '');
  if (pw.length < 6) {
    throw Object.assign(new Error('Password kam se kam 6 characters ka hona chahiye'), { status: 400 });
  }
  await store.update((st) => {
    st.auth = { user, hash: hashPassword(pw), updatedAt: Date.now() };
  });
  sessions.clear();
}

function rateLimited(ip) {
  const rec = tries.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.ts > cfg.LOGIN_WINDOW) {
    tries.delete(ip);
    return false;
  }
  return rec.count >= cfg.LOGIN_MAX_TRIES;
}
function bumpTry(ip) {
  const rec = tries.get(ip);
  if (!rec || Date.now() - rec.ts > cfg.LOGIN_WINDOW) tries.set(ip, { count: 1, ts: Date.now() });
  else rec.count++;
}
const clearTries = (ip) => tries.delete(ip);

function createSession(user, ip) {
  const t = crypto.randomBytes(32).toString('base64url');
  sessions.set(t, { user, ip, created: Date.now(), expires: Date.now() + cfg.SESSION_TTL });
  for (const [k, s] of sessions) if (s.expires < Date.now()) sessions.delete(k);
  return t;
}

const destroySession = (t) => t && sessions.delete(t);

function parseCookies(str) {
  const out = {};
  String(str || '')
    .split(';')
    .forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
  return out;
}

function sessionFromReq(req) {
  if (cfg.NO_AUTH) return { user: 'local', token: 'noauth', expires: Date.now() + 1e9 };
  let t = parseCookies(req.headers.cookie || '').forge_session || '';
  const authz = String(req.headers.authorization || '');
  if (authz.toLowerCase().startsWith('bearer ')) t = authz.slice(7).trim();
  if (!t) {
    try {
      t = new URL(req.url, 'http://x').searchParams.get('token') || '';
    } catch {}
  }
  if (!t) return null;
  const s = sessions.get(t);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(t);
    return null;
  }
  s.expires = Date.now() + cfg.SESSION_TTL;
  return { ...s, token: t };
}

function sessionCookie(t, secure) {
  const parts = [`forge_session=${t}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(cfg.SESSION_TTL / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

const clearCookie = () => 'forge_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

module.exports = {
  needsSetup,
  setPassword,
  verifyPassword,
  hashPassword,
  rateLimited,
  bumpTry,
  clearTries,
  createSession,
  destroySession,
  sessionFromReq,
  sessionCookie,
  clearCookie,
  parseCookies
};
