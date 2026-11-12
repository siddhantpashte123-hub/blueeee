'use strict';
/** Chhote helpers — koi npm dependency nahi. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

/** Random id: 10 hex chars */
function uid(n = 10) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** URL-safe random token */
function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** "My Cool VM" -> "my-cool-vm" */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * Command chalata hai. Kabhi throw nahi karta (code/stdout/stderr deta hai).
 */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env || process.env,
        timeout: opts.timeout || 120000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || '') || (err && err.killed ? 'timeout' : ''),
          error: err || null
        });
      }
    );
    if (opts.input != null && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/** Command chalata hai, fail hone par throw karta hai. */
async function runOk(cmd, args = [], opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').trim() || `exit ${r.code}`;
    const err = new Error(`${path.basename(cmd)} failed: ${msg}`);
    err.code = r.code;
    err.stderr = msg;
    throw err;
  }
  return r.stdout;
}

/** command ka absolute path ya null */
async function which(bin) {
  const r = await run('sh', ['-c', `command -v ${JSON.stringify(bin)} 2>/dev/null || true`], { timeout: 5000 });
  const p = r.stdout.trim();
  return p || null;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function readJson(file, def) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    if (!txt.trim()) return def;
    return JSON.parse(txt);
  } catch (e) {
    return def;
  }
}

/** Atomic write: temp file + rename (crash safe) */
async function writeJsonAtomic(file, obj) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(p) {
  try {
    const st = await fsp.stat(p);
    return st.size;
  } catch {
    return 0;
  }
}

/** Kya port free hai? (bind test) */
function portFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

/** base se start karke pehla free port dhoondhta hai */
async function pickPort(base, max, taken = new Set()) {
  for (let p = base; p <= Math.min(max, base + 400); p++) {
    if (taken.has(p)) continue;
    if (await portFree(p, '127.0.0.1')) return p;
  }
  return null;
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function hostMemMb() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /MemTotal:\s+(\d+) kB/.exec(txt);
    if (m) return Math.floor(parseInt(m[1], 10) / 1024);
  } catch {}
  return Math.floor(os.totalmem() / 1048576);
}

function hostLoad() {
  try {
    const la = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
    return { load1: parseFloat(la[0]) || 0, load5: parseFloat(la[1]) || 0, load15: parseFloat(la[2]) || 0, procs: la[3] || '' };
  } catch {
    return { load1: os.loadavg()[0], load5: os.loadavg()[1], load15: os.loadavg()[2], procs: '' };
  }
}

/** /proc/<pid> se info; process nahi hai to null */
function procInfo(pid) {
  if (!pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const rest = stat.slice(close + 2).split(' ');
    // rest[0]=state rest[1]=ppid
    const state = rest[0];
    const ppid = parseInt(rest[1], 10);
    let rss = 0;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+) kB/.exec(status);
      if (m) rss = parseInt(m[1], 10) * 1024;
    } catch {}
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {}
    return { pid, state, ppid, rss, cmdline, alive: state !== 'Z' };
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  const p = procInfo(pid);
  return !!(p && p.alive);
}

/** human friendly sizes for names */
function safeName(s, def = 'vm') {
  const v = String(s || '')
    .replace(/[^A-Za-z0-9 _.\-]/g, '')
    .trim()
    .slice(0, 40);
  return v || def;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  uid,
  token,
  slugify,
  run,
  runOk,
  which,
  ensureDir,
  readJson,
  writeJsonAtomic,
  exists,
  fileSize,
  portFree,
  pickPort,
  clampInt,
  fmtBytes,
  hostMemMb,
  hostLoad,
  procInfo,
  pidAlive,
  safeName,
  sleep
};
