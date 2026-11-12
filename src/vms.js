'use strict';
/**
 * VM lifecycle: create / start / stop / clone / delete / snapshot / resize.
 * Yahan policy hai; asli qemu calls src/qemu.js me hain.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');
const qemu = require('./qemu');
const images = require('./images');
const serial = require('./serial');
const { buildSeedIso } = require('./cloudinit');
const { uid, slugify, clampInt, safeName, ensureDir, exists, fileSize, pickPort, sleep, run, hostMemMb, portFree } = require('./util');

const log = (...a) => console.log('[vms]', ...a);
const cache = new Map(); // id -> {ts, status}

function password(len = 12) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[b[i] % chars.length];
  return out;
}

function find(id) {
  return (store.get().vms || []).find((v) => v.id === id) || null;
}

function need(id) {
  const vm = find(id);
  if (!vm) throw Object.assign(new Error('VM nahi mila'), { status: 404 });
  return vm;
}

async function liveStatus(vm, { fresh = false } = {}) {
  const c = cache.get(vm.id);
  if (!fresh && c && Date.now() - c.ts < 3000) return c.status;
  const st = await qemu.status(vm);
  cache.set(vm.id, { ts: Date.now(), status: st });
  return st;
}

function invalidate(id) {
  cache.delete(id);
}

/** public shape (password/keys chhupa ke) */
function publicVm(vm, st) {
  const status = st || cache.get(vm.id)?.status || { running: false, state: 'stopped', pid: null, rss: 0 };
  return {
    id: vm.id,
    name: vm.name,
    hostname: vm.hostname,
    cpu: vm.cpu,
    memMB: vm.memMB,
    diskGB: vm.diskGB,
    imageId: vm.imageId,
    imageName: vm.imageName,
    user: vm.user,
    sshPort: vm.sshPort,
    autostart: !!vm.autostart,
    notes: vm.notes || '',
    createdAt: vm.createdAt,
    updatedAt: vm.updatedAt,
    shareToken: vm.shareToken,
    status: {
      running: !!status.running,
      state: status.state || (status.running ? 'running' : 'stopped'),
      pid: status.pid || null,
      rss: status.rss || 0
    }
  };
}

/** list with live status (parallel, thoda cached) */
async function list() {
  const st = store.get();
  const out = [];
  for (const vm of st.vms || []) {
    const s = await liveStatus(vm);
    out.push(publicVm(vm, s));
  }
  return out;
}

async function get(id, opts = {}) {
  const vm = need(id);
  const st = await liveStatus(vm, opts);
  return { ...publicVm(vm, st), sshKeys: vm.sshKeys || [], password: vm.password };
}

async function withSecret(id) {
  const vm = need(id);
  return { vm, password: vm.password };
}

async function allocPort() {
  const used = new Set((store.get().vms || []).map((v) => v.sshPort).filter(Boolean));
  const p = await pickPort(cfg.SSH_PORT_BASE, cfg.SSH_PORT_MAX, used);
  if (!p) throw Object.assign(new Error('Free SSH port nahi mila (22000-22999 range)'), { status: 507 });
  return p;
}

function validateCreate(input) {
  const name = safeName(input.name, '');
  if (!name) throw Object.assign(new Error('VM ka naam zaroori hai'), { status: 400 });
  const st = store.get();
  if ((st.vms || []).length >= cfg.MAX_VMS) {
    throw Object.assign(new Error(`Max ${cfg.MAX_VMS} VMs allowed hain`), { status: 400 });
  }
  const dup = (st.vms || []).find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (dup) throw Object.assign(new Error('Is naam ka VM pehle se hai'), { status: 409 });

  const cpu = clampInt(input.cpu, 1, cfg.MAX_CPU, cfg.DEFAULT_CPU);
  const memMB = clampInt(input.memMB, 256, Math.max(256, hostMemMb() - 256), cfg.DEFAULT_MEM_MB);
  const diskGB = clampInt(input.diskGB, 2, cfg.MAX_DISK_GB, cfg.DEFAULT_DISK_GB);
  return { name, cpu, memMB, diskGB };
}

/** naya VM: overlay disk + cloud-init seed + port */
async function create(input = {}) {
  const { name, cpu, memMB, diskGB } = validateCreate(input);
  const image = images.getImage(input.imageId);
  if (!image) throw Object.assign(new Error('Base image select karein'), { status: 400 });
  const imgPath = images.imagePath(image);
  if (!(await exists(imgPath))) {
    throw Object.assign(new Error('Image file maujood nahi — pehle download/upload karein'), { status: 409 });
  }
  const e = await qemu.env();
  if (!e.ready) {
    throw Object.assign(
      new Error('QEMU installed nahi hai. Chalao: sudo apt install -y qemu-system-x86 qemu-utils'),
      { status: 503 }
    );
  }

  const { format, virtualSize } = await images.imageFormat(image);
  let size = diskGB;
  if (virtualSize && size * 1024 ** 3 < virtualSize) {
    size = Math.ceil(virtualSize / 1024 ** 3) + 1; // base image se chhoti disk nahi ho sakti
  }

  const id = `vm-${slugify(name).slice(0, 12)}-${uid(4)}`;
  const dir = qemu.vmDir(id);
  await ensureDir(dir);

  const vm = {
    id,
    name,
    hostname: slugify(name) || id,
    imageId: image.id,
    imageName: image.name,
    imageFile: image.file,
    cpu,
    memMB,
    diskGB: size,
    sshPort: await allocPort(),
    user: (input.user && String(input.user).replace(/[^a-z0-9_-]/gi, '').slice(0, 24)) || image.user || 'ubuntu',
    password: input.password ? String(input.password).slice(0, 64) : password(),
    sshKeys: Array.isArray(input.sshKeys) ? input.sshKeys.filter(Boolean).slice(0, 10) : [],
    shareToken: crypto.randomBytes(16).toString('base64url'),
    autostart: !!input.autostart,
    notes: String(input.notes || '').slice(0, 500),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: 'created'
  };

  try {
    await qemu.qimg([
      'create',
      '-f',
      'qcow2',
      '-b',
      imgPath,
      '-F',
      format,
      qemu.diskPath(id),
      `${size}G`
    ]);
    await writeSeed(vm);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  await store.update((s) => {
    s.vms.push(vm);
  });

  if (input.start) {
    await start(id).catch((err) => log('auto-start failed:', err.message));
  }
  return get(id, { fresh: true });
}

async function writeSeed(vm) {
  const iso = buildSeedIso(vm);
  await ensureDir(path.dirname(qemu.seedPath(vm.id)));
  await fsp.writeFile(qemu.seedPath(vm.id), iso, { mode: 0o600 });
}

async function start(id) {
  const vm = need(id);
  const st = await qemu.status(vm);
  if (st.running) return get(id, { fresh: true });

  // memory check — host par itni RAM bachi hai?
  const freeMb = hostMemMb();
  const usedMb = (store.get().vms || []).reduce((a, v) => a + (v.memMB || 0), 0);
  if (vm.memMB > freeMb) {
    log(`warning: ${vm.name} ko ${vm.memMB}MB chahiye, host par ${freeMb}MB hai`);
  }
  if (!(await exists(qemu.diskPath(id)))) {
    throw Object.assign(new Error('Disk file gayab hai — VM ko reinstall karein'), { status: 409 });
  }

  const r = await qemu.start(vm, log);
  // console bridge jod do taaki boot log capture ho
  const bridge = serial.getBridge(vm, qemu.serialPath(id));
  bridge.connect().catch(() => {});

  await store.update((s) => {
    const v = s.vms.find((x) => x.id === id);
    if (v) {
      v.state = 'running';
      v.lastStart = Date.now();
      v.updatedAt = Date.now();
    }
  });
  invalidate(id);
  return { ...(await get(id, { fresh: true })), _start: r };
}

async function stop(id) {
  const vm = need(id);
  const r = await qemu.stop(vm, log);
  serial.dropBridge(id);
  await store.update((s) => {
    const v = s.vms.find((x) => x.id === id);
    if (v) {
      v.state = 'stopped';
      v.lastStop = Date.now();
      v.updatedAt = Date.now();
    }
  });
  invalidate(id);
  return { ok: true, ...r };
}

async function restart(id) {
  await stop(id);
  await sleep(500);
  await start(id);
  return get(id, { fresh: true });
}

async function remove(id, { keepDisk = false } = {}) {
  const vm = need(id);
  await qemu.stop(vm, log).catch(() => {});
  serial.dropBridge(id);
  if (!keepDisk) {
    await fsp.rm(qemu.vmDir(id), { recursive: true, force: true }).catch(() => {});
  }
  await store.update((s) => {
    s.vms = s.vms.filter((v) => v.id !== id);
  });
  invalidate(id);
  return { ok: true };
}

async function update(id, patch = {}) {
  const vm = need(id);
  const st = await qemu.status(vm);
  const changes = {};

  if (patch.name !== undefined) {
    const name = safeName(patch.name, '');
    if (!name) throw Object.assign(new Error('Naam khali nahi ho sakta'), { status: 400 });
    const dup = (store.get().vms || []).find((v) => v.id !== id && v.name.toLowerCase() === name.toLowerCase());
    if (dup) throw Object.assign(new Error('Is naam ka VM pehle se hai'), { status: 409 });
    changes.name = name;
  }
  if (patch.autostart !== undefined) changes.autostart = !!patch.autostart;
  if (patch.notes !== undefined) changes.notes = String(patch.notes).slice(0, 500);

  const needStopped = patch.cpu !== undefined || patch.memMB !== undefined;
  if (needStopped && st.running) {
    throw Object.assign(new Error('CPU/RAM badalne se pehle VM ko stop karein'), { status: 409 });
  }
  if (patch.cpu !== undefined) changes.cpu = clampInt(patch.cpu, 1, cfg.MAX_CPU, vm.cpu);
  if (patch.memMB !== undefined) {
    changes.memMB = clampInt(patch.memMB, 256, Math.max(256, hostMemMb() - 256), vm.memMB);
  }
  if (patch.password !== undefined) {
    const pw = String(patch.password || '').trim();
    if (pw.length < 6) throw Object.assign(new Error('Password kam se kam 6 characters'), { status: 400 });
    changes.password = pw.slice(0, 64);
    changes.passwordNote = 'Naya password agle reinstall par lagta hai';
  }
  if (patch.sshKeys !== undefined) {
    changes.sshKeys = (Array.isArray(patch.sshKeys) ? patch.sshKeys : []).filter(Boolean).slice(0, 10);
  }

  await store.update((s) => {
    const v = s.vms.find((x) => x.id === id);
    Object.assign(v, changes, { updatedAt: Date.now() });
  });
  return get(id, { fresh: true });
}

/** Disk ko base image se dobara banata hai (sab data delete) */
async function reinstall(id) {
  const vm = need(id);
  await qemu.stop(vm, log);
  serial.dropBridge(id);
  const image = images.getImage(vm.imageId);
  if (!image) throw Object.assign(new Error('Base image delete ho gayi hai'), { status: 409 });
  const imgPath = images.imagePath(image);
  if (!(await exists(imgPath))) throw Object.assign(new Error('Base image file missing'), { status: 409 });

  const { format, virtualSize } = await images.imageFormat(image);
  let size = vm.diskGB;
  if (virtualSize && size * 1024 ** 3 < virtualSize) size = Math.ceil(virtualSize / 1024 ** 3) + 1;

  await ensureDir(qemu.vmDir(id));
  await fsp.rm(qemu.diskPath(id), { force: true }).catch(() => {});
  await qemu.qimg(['create', '-f', 'qcow2', '-b', imgPath, '-F', format, qemu.diskPath(id), `${size}G`]);
  vm.diskGB = size;
  await writeSeed(vm);
  await store.update((s) => {
    const v = s.vms.find((x) => x.id === id);
    if (v) {
      v.diskGB = size;
      v.state = 'stopped';
      v.updatedAt = Date.now();
    }
  });
  invalidate(id);
  return get(id, { fresh: true });
}

async function clone(id, { name } = {}) {
  const src = need(id);
  const newName = safeName(name, `${src.name}-copy`);
  const st = await qemu.status(src);
  if (st.running) await stop(id);

  const { name: cleanName, cpu, memMB, diskGB } = validateCreate({
    name: newName,
    cpu: src.cpu,
    memMB: src.memMB,
    diskGB: src.diskGB
  });

  const newId = `vm-${slugify(cleanName).slice(0, 12)}-${uid(4)}`;
  await ensureDir(qemu.vmDir(newId));
  await qemu.qimg(['convert', '-O', 'qcow2', qemu.diskPath(id), qemu.diskPath(newId)]);

  const vm = {
    ...src,
    id: newId,
    name: cleanName,
    hostname: slugify(cleanName) || newId,
    diskGB,
    cpu,
    memMB,
    sshPort: await allocPort(),
    password: password(),
    shareToken: crypto.randomBytes(16).toString('base64url'),
    autostart: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: 'stopped'
  };
  // disk resize (agar naya bada hai)
  const info = await qemu.diskInfo(vm);
  await writeSeed(vm);
  await store.update((s) => {
    s.vms.push(vm);
  });
  invalidate(newId);
  return get(newId, { fresh: true });
}

async function resize(id, diskGB) {
  const vm = need(id);
  const st = await qemu.status(vm);
  if (st.running) throw Object.assign(new Error('Disk resize ke liye VM stop karein'), { status: 409 });
  const gb = clampInt(diskGB, vm.diskGB, cfg.MAX_DISK_GB, vm.diskGB);
  await qemu.qimg(['resize', qemu.diskPath(id), `${gb}G`]);
  await store.update((s) => {
    const v = s.vms.find((x) => x.id === id);
    v.diskGB = gb;
    v.updatedAt = Date.now();
  });
  return get(id, { fresh: true });
}

// ---------------- snapshots ----------------
function parseHmpSnapshots(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s{2,}/.exec(line);
    if (m) out.push({ id: m[1], tag: m[2], size: m[3], date: m[4].trim() });
  }
  return out;
}

async function snapshots(id) {
  const vm = need(id);
  const st = await qemu.status(vm);
  if (st.running) {
    try {
      const q = await qemu.qmpConnect(vm);
      const txt = await q.hmp('info snapshots');
      q.close();
      return parseHmpSnapshots(txt);
    } catch {
      return [];
    }
  }
  const e = await qemu.env();
  const r = await run(e.qemuImg, ['snapshot', '-l', qemu.diskPath(id)], { timeout: 20000 });
  if (r.code !== 0) return [];
  const out = [];
  for (const line of r.stdout.split('\n').slice(2)) {
    const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+|\S+)\s+(\d{4}-\d{2}-\d{2}.*)$/.exec(line);
    if (m) out.push({ id: m[1], tag: m[2], size: m[3], date: m[4].trim() });
  }
  return out;
}

async function snapshotCreate(id, tag) {
  const vm = need(id);
  const t = String(safeName(tag, `snap-${Date.now()}`)).replace(/\s+/g, '-').slice(0, 40);
  const st = await qemu.status(vm);
  if (st.running) {
    const q = await qemu.qmpConnect(vm);
    try {
      const r = await q.hmp(`savevm ${t}`);
      if (String(r || '').toLowerCase().includes('error')) throw new Error(String(r));
    } finally {
      q.close();
    }
  } else {
    await qemu.qimg(['snapshot', '-c', t, qemu.diskPath(id)]);
  }
  return { ok: true, tag: t, snapshots: await snapshots(id) };
}

async function snapshotRestore(id, tag) {
  const vm = need(id);
  const st = await qemu.status(vm);
  if (st.running) {
    const q = await qemu.qmpConnect(vm);
    try {
      const r = await q.hmp(`loadvm ${tag}`);
      if (String(r || '').toLowerCase().includes('error')) throw new Error(String(r));
    } finally {
      q.close();
    }
  } else {
    await qemu.qimg(['snapshot', '-a', tag, qemu.diskPath(id)]);
  }
  return { ok: true };
}

async function snapshotDelete(id, tag) {
  const vm = need(id);
  const st = await qemu.status(vm);
  if (st.running) {
    const q = await qemu.qmpConnect(vm);
    try {
      await q.hmp(`delvm ${tag}`);
    } finally {
      q.close();
    }
  } else {
    await qemu.qimg(['snapshot', '-d', tag, qemu.diskPath(id)]);
  }
  return { ok: true };
}

// ---------------- console ----------------
function consoleBridge(id) {
  const vm = need(id);
  return serial.getBridge(vm, qemu.serialPath(id));
}

async function consoleConnect(id) {
  const b = consoleBridge(id);
  await b.connect();
  return b;
}

// ---------------- boot / shutdown ----------------
/** Panel start hone par: purane chal rahe VMs se judo, autostart wale chalao */
async function boot() {
  const st = store.get();
  for (const vm of st.vms || []) {
    const s = await qemu.status(vm);
    if (s.running) {
      const b = serial.getBridge(vm, qemu.serialPath(vm.id));
      b.connect({ retries: 5 }).catch(() => {});
      log(`${vm.name} pehle se chal raha hai (pid ${s.pid})`);
    } else if (vm.autostart) {
      try {
        await start(vm.id);
        log(`${vm.name} autostart ho gaya`);
      } catch (e) {
        log(`${vm.name} autostart fail: ${e.message}`);
      }
    }
  }
}

async function shutdownAll() {
  for (const vm of store.get().vms || []) {
    const s = await qemu.status(vm);
    if (s.running) await qemu.stop(vm, log).catch(() => {});
  }
}

/** dashboard stats */
async function stats() {
  const vms = store.get().vms || [];
  let running = 0;
  let rss = 0;
  let allocMem = 0;
  for (const vm of vms) {
    const s = await liveStatus(vm, { fresh: true });
    if (s.running) {
      running++;
      rss += s.rss || 0;
    }
    allocMem += vm.memMB || 0;
  }
  return {
    total: vms.length,
    running,
    stopped: vms.length - running,
    rss,
    allocMem,
    hostMem: hostMemMb(),
    hostCpu: require('os').cpus().length
  };
}

module.exports = {
  list,
  get,
  find,
  need,
  create,
  start,
  stop,
  restart,
  remove,
  update,
  reinstall,
  clone,
  resize,
  snapshots,
  snapshotCreate,
  snapshotRestore,
  snapshotDelete,
  consoleBridge,
  consoleConnect,
  boot,
  shutdownAll,
  stats,
  publicVm,
  liveStatus,
  allocatePort: allocPort,
  generatePassword: password
};
