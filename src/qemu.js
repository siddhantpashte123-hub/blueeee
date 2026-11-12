'use strict';
/**
 * QEMU ke saath baat karne ki poori layer:
 *  - binary/accel detection (KVM mile to KVM, warna TCG software mode)
 *  - qemu arguments banana
 *  - start / stop / status / snapshots
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const { run, runOk, which, exists, pidAlive, procInfo, sleep, ensureDir } = require('./util');
const { Qmp } = require('./qmp');

const vmDir = (id) => path.join(cfg.VMS_DIR, id);
const diskPath = (id) => path.join(vmDir(id), 'disk.qcow2');
const seedPath = (id) => path.join(vmDir(id), 'seed.iso');
const qmpPath = (id) => path.join(vmDir(id), 'qmp.sock');
const serialPath = (id) => path.join(vmDir(id), 'serial.sock');
const pidPath = (id) => path.join(vmDir(id), 'qemu.pid');

let envCache = null;

/** qemu binaries + KVM check (ek baar cache hota hai) */
async function env({ refresh = false } = {}) {
  if (envCache && !refresh) return envCache;
  const qemuBin = await which(cfg.QEMU_BIN);
  const qemuImg = await which(cfg.QEMU_IMG);
  let kvm = false;
  let kvmReason = '/dev/kvm nahi mila';
  try {
    await fsp.access('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    kvm = true;
    kvmReason = null;
  } catch (e) {
    kvmReason =
      e.code === 'EACCES'
        ? '/dev/kvm ka permission nahi hai (panel user ko kvm group me daalein)'
        : '/dev/kvm maujood nahi hai';
  }
  let version = '';
  if (qemuBin) {
    if (envCache && envCache.qemuBin === qemuBin && envCache.version) {
      version = envCache.version;
    } else {
      const r = await run(qemuBin, ['--version'], { timeout: 8000 });
      version = (r.stdout.split('\n')[0] || '').trim();
    }
  }
  envCache = { qemuBin, qemuImg, kvm, kvmReason, version, ready: !!(qemuBin && qemuImg) };
  return envCache;
}

function accelArgs(e) {
  if (e.kvm) return ['-machine', `${cfg.QEMU_MACHINE},accel=kvm`, '-cpu', 'host'];
  // KVM nahi hai: TCG (software emulation). Chalega, par slow.
  return ['-machine', `${cfg.QEMU_MACHINE},accel=tcg`, '-cpu', 'max'];
}

/**
 * Asli args (env ke saath). export isliye taaki tests me inspect kar sakein.
 */
function argsFor(vm, e) {
  const args = [
    '-name', `vpsdeck-${vm.id}`,
    ...accelArgs(e),
    '-smp', `${vm.cpu},sockets=1,cores=${vm.cpu},threads=1`,
    '-m', String(vm.memMB),
    '-rtc', 'base=utc',
    '-boot', 'order=c',
    // OS disk (backing image se bana qcow2)
    '-drive', `file=${diskPath(vm.id)},if=virtio,format=qcow2,cache=writeback,discard=unmap,media=disk`,
    // cloud-init seed
    '-drive', `file=${seedPath(vm.id)},if=virtio,format=raw,media=cdrom,readonly=on`,
    // network: user mode (SLIRP) + SSH forward, root ki zaroorat nahi
    '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${vm.sshPort}-:22`,
    '-device', 'virtio-net-pci,netdev=net0',
    // entropy (boot fast + ssh keys jaldi ban jayein)
    '-object', 'rng-random,filename=/dev/urandom,id=rng0',
    '-device', 'virtio-rng-pci,rng=rng0',
    // no GUI; console serial par
    '-display', 'none',
    '-vga', 'none',
    '-serial', `unix:${serialPath(vm.id)},server=on,wait=off`,
    '-qmp', `unix:${qmpPath(vm.id)},server=on,wait=off`,
    '-pidfile', pidPath(vm.id)
  ];
  return args;
}

/** Purane socket/pid file hatao (crash ke baad zaroori) */
async function cleanRuntimeFiles(id) {
  for (const p of [qmpPath(id), serialPath(id), pidPath(id)]) {
    await fsp.rm(p, { force: true }).catch(() => {});
  }
}

async function currentPid(id) {
  try {
    const txt = await fsp.readFile(pidPath(id), 'utf8');
    const pid = parseInt(txt.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** VM chal raha hai ya nahi (pid + QMP dono se) */
async function status(vm) {
  const pid = await currentPid(vm.id);
  const alive = pid ? pidAlive(pid) : false;
  if (!alive) {
    return { running: false, pid: pid || null, state: 'stopped', rss: 0 };
  }
  let state = 'running';
  try {
    const q = new Qmp(qmpPath(vm.id), { timeout: 2500 });
    await q.connect();
    const st = await q.execute('query-status');
    state = (st && st.status) || 'running';
    q.close();
  } catch {
    // QMP se baat nahi hui par process zinda hai — boot ho raha hoga
    state = 'running';
  }
  const info = procInfo(pid);
  return { running: true, pid, state, rss: info ? info.rss : 0 };
}

/** QEMU start — detached, isliye panel band hone par bhi chalta rehta hai */
async function start(vm, log = () => {}) {
  const e = await env();
  if (!e.ready) {
    throw new Error(
      'QEMU installed nahi hai. VPS par chalayein: sudo apt install -y qemu-system-x86 qemu-utils'
    );
  }
  const st = await status(vm);
  if (st.running) return { already: true, pid: st.pid };

  await ensureDir(vmDir(vm.id));
  await cleanRuntimeFiles(vm.id);

  const args = argsFor(vm, e);
  log(`qemu ${args.join(' ')}`);

  const child = spawn(e.qemuBin, args, createSpawnOpts());
  let spawnErr = null;
  child.once('error', (err) => {
    spawnErr = err;
  });
  child.unref();

  // pid file qemu khud likhta hai; thoda wait karke confirm karein
  let pid = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (spawnErr) throw spawnErr;
    pid = await currentPid(vm.id);
    if (pid && pidAlive(pid)) break;
    if (child.exitCode != null && child.exitCode !== 0) break;
  }
  if (!pid || !pidAlive(pid)) {
    const err = new Error(
      'QEMU start nahi hua. Aksar wajah: memory kam hai, ya /dev/kvm ka permission issue.'
    );
    err.code = 'QEMU_START_FAILED';
    throw err;
  }
  return { pid, args };
}

function createSpawnOpts() {
  return {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: cfg.DATA_DIR,
    env: process.env
  };
}

/** Narm shutdown: ACPI power button -> phir quit -> SIGTERM -> SIGKILL */
async function stop(vm, log = () => {}) {
  const pid = await currentPid(vm.id);
  if (!pid || !pidAlive(pid)) {
    await cleanRuntimeFiles(vm.id);
    return { stopped: true, wasRunning: false };
  }

  // 1) graceful
  try {
    const q = new Qmp(qmpPath(vm.id), { timeout: 3000 });
    await q.connect();
    try {
      await q.execute('system_powerdown');
    } catch {}
    q.close();
  } catch {}

  const deadline = Date.now() + cfg.STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      await cleanRuntimeFiles(vm.id);
      return { stopped: true, wasRunning: true };
    }
    await sleep(400);
  }

  // 2) QMP quit
  try {
    const q = new Qmp(qmpPath(vm.id), { timeout: 2500 });
    await q.connect();
    await q.execute('quit');
    q.close();
  } catch {}
  for (let i = 0; i < 25; i++) {
    if (!pidAlive(pid)) {
      await cleanRuntimeFiles(vm.id);
      return { stopped: true, wasRunning: true, forced: 'quit' };
    }
    await sleep(200);
  }

  // 3) signals
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 20; i++) {
    if (!pidAlive(pid)) break;
    await sleep(200);
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    log(`pid ${pid} ko SIGKILL kiya`);
  }
  await cleanRuntimeFiles(vm.id);
  return { stopped: true, wasRunning: true, forced: 'kill' };
}

async function qmpConnect(vm, timeout = 4000) {
  const q = new Qmp(qmpPath(vm.id), { timeout });
  await q.connect();
  return q;
}

/** qemu-img info se disk ka actual (allocated) size */
async function diskInfo(vm) {
  const e = await env();
  if (!e.qemuImg || !(await exists(diskPath(vm.id)))) return null;
  const r = await run(e.qemuImg, ['info', '--output=json', diskPath(vm.id)], { timeout: 15000 });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    return { virtual: j['virtual-size'] || 0, actual: j['actual-size'] || 0, format: j.format };
  } catch {
    return null;
  }
}

async function qimg(args, timeout = 120000) {
  const e = await env();
  if (!e.qemuImg) throw new Error('qemu-img install nahi hai (apt install qemu-utils)');
  return runOk(e.qemuImg, args, { timeout });
}

module.exports = {
  env,
  vmDir,
  diskPath,
  seedPath,
  qmpPath,
  serialPath,
  pidPath,
  argsFor,
  start,
  stop,
  status,
  currentPid,
  cleanRuntimeFiles,
  qmpConnect,
  diskInfo,
  qimg,
  accelArgs
};
