'use strict';
/** Helpers — koi npm dependency nahi. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const uid = (n = 10) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env || process.env,
        timeout: opts.timeout || 60000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err || null
        });
      }
    );
    if (opts.input != null && child.stdin) child.stdin.end(opts.input);
  });
}

async function which(bin) {
  const r = await run('sh', ['-c', `command -v ${JSON.stringify(bin)} 2>/dev/null || true`], { timeout: 5000 });
  return r.stdout.trim() || null;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function readJson(file, def) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return txt.trim() ? JSON.parse(txt) : def;
  } catch {
    return def;
  }
}

async function writeJsonAtomic(file, obj) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
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
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

function portFree(port, host = '127.0.0.1') {
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

function memInfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => {
      const m = new RegExp(`${k}:\\s+(\\d+) kB`).exec(txt);
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const total = g('MemTotal');
    const avail = g('MemAvailable') || g('MemFree');
    return { total, free: avail, used: total - avail };
  } catch {
    return { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() };
  }
}

function procInfo(pid) {
  if (!pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const rest = stat.slice(close + 2).split(' ');
    let rss = 0;
    try {
      const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) rss = parseInt(m[1], 10) * 1024;
    } catch {}
    return { pid, state: rest[0], rss, alive: rest[0] !== 'Z' };
  } catch {
    return null;
  }
}

const pidAlive = (pid) => {
  const p = procInfo(pid);
  return !!(p && p.alive);
};

/** Workspace ke andar safe path — bahar nikalne ki koshish block */
function safeJoin(root, rel) {
  const cleaned = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  const abs = path.resolve(root, cleaned);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// ---------------------------------------------------------------- zip writer
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Bina compression (store) zip — chhote projects ke liye perfect */
function zipFiles(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(String(f.name).replace(/^\/+/, ''), 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data || ''), 'utf8');
    const crc = crc32(data);
    const time = 0;
    const date = 0x21; // 1980-01-01

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version
    lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, end]);
}

module.exports = {
  uid,
  token,
  sleep,
  run,
  which,
  ensureDir,
  readJson,
  writeJsonAtomic,
  exists,
  fileSize,
  portFree,
  fmtBytes,
  hostMemMb,
  memInfo,
  procInfo,
  pidAlive,
  safeJoin,
  zipFiles,
  crc32
};
