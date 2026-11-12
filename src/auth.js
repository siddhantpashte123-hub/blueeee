'use strict';
/** Login: scrypt password hash + in-memory sessions + cookie. */
const crypto = require('crypto');
const { SESSION_TTL, LOGIN_MAX_TRIES, LOGIN_WINDOW } = require('./config');
const store = require('./store');

const sessions = new Map(); // token -> { user, expires, created, ip }
const tries = new Map(); // ip -> { count, ts }

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    // scrypt $ N $ r $ p $ salt $ hash
    const N = parseInt(parts[1], 10) || 16384;
    const r = parseInt(parts[2], 10) || 8;
    const p = parseInt(parts[3], 10) || 1;
    const salt = Buffer.from(parts[4], 'base64');
    const want = Buffer.from(parts[5], 'base64');
    const got = crypto.scryptSync(String(password), salt, want.length, { N, r, p });
    return crypto.timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

function needsSetup() {
  const st = store.get();
  return !st.auth || !st.auth.hash;
}

async function setPassword(password, user = 'admin') {
  const pw = String(password || '');
  if (pw.length < 6) {
    const e = new Error('Password kam se kam 6 characters ka hona chahiye');
    e.status = 400;
    throw e;
  }
  await store.update((st) => {
    st.auth = { user, hash: hashPassword(pw), updatedAt: Date.now() };
  });
  sessions.clear();
}

function rateLimited(ip) {
  const rec = tries.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.ts > LOGIN_WINDOW) {
    tries.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_TRIES;
}

function bumpTry(ip) {
  const rec = tries.get(ip);
  if (!rec || Date.now() - rec.ts > LOGIN_WINDOW) {
    tries.set(ip, { count: 1, ts: Date.now() });
  } else {
    rec.count++;
  }
}

function clearTries(ip) {
  tries.delete(ip);
}

function createSession(user, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { user, ip, created: Date.now(), expires: Date.now() + SESSION_TTL });
  // purane expired sessions saaf
  for (const [t, s] of sessions) if (s.expires < Date.now()) sessions.delete(t);
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function sessionFromReq(req) {
  const cookie = parseCookies(req.headers.cookie || '');
  let token = cookie.bd_vps_session || cookie.vpsdeck_session || '';
  const authz = String(req.headers.authorization || '');
  if (authz.toLowerCase().startsWith('bearer ')) token = authz.slice(7).trim();
  if (!token) {
    try {
      const u = new URL(req.url, 'http://x');
      token = u.searchParams.get('token') || '';
    } catch {}
  }
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  s.expires = Date.now() + SESSION_TTL;
  return { ...s, token };
}

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

function sessionCookie(token, secure) {
  const parts = [
    `bd_vps_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL / 1000)}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie() {
  return 'bd_vps_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function sessionCount() {
  return sessions.size;
}

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
  parseCookies,
  sessionCount
};
