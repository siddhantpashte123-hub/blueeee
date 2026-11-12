#!/usr/bin/env node
'use strict';
/**
 * Integration test: mock QEMU ke saath poora VM lifecycle.
 * Chalane ke liye: node tests/lifecycle-test.js
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), `vpsdeck-test-${Date.now()}`);
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ''}\n`);
  }
}

let cookie = '';

function request(method, urlPath, body, raw = false) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers: Object.assign({}, cookie ? { Cookie: cookie } : {}, data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}) },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          const sc = res.headers['set-cookie'];
          if (sc && sc[0]) cookie = sc[0].split(';')[0];
          resolve({ status: res.statusCode, json, text, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** SSE se thoda data padhta hai */
function readSse(urlPath, ms = 1500) {
  return new Promise((resolve) => {
    let out = '';
    const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, headers: { Cookie: cookie } }, (res) => {
      res.on('data', (c) => {
        out += c.toString();
        if (out.length > 1200) req.destroy();
      });
    });
    req.on('error', () => {});
    setTimeout(() => {
      try {
        req.destroy();
      } catch {}
      resolve(out);
    }, ms);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000, step = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

async function main() {
  await fsp.mkdir(DATA, { recursive: true });
  execSync(`chmod +x ${path.join(ROOT, 'tests/mock-qemu.js')} ${path.join(ROOT, 'tests/mock-qemu-img.js')}`);

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      QEMU_BIN: path.join(ROOT, 'tests/mock-qemu.js'),
      QEMU_IMG: path.join(ROOT, 'tests/mock-qemu-img.js')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvOut = '';
  server.stdout.on('data', (d) => (srvOut += d.toString()));
  server.stderr.on('data', (d) => (srvOut += d.toString()));

  const cleanup = () => {
    try {
      server.kill('SIGTERM');
    } catch {}
    // leftover mock qemu — sirf apne data dir ke pids
    try {
      for (const d of fs.readdirSync(path.join(DATA, 'vms')).map((v) => path.join(DATA, 'vms', v))) {
        try {
          const pid = parseInt(fs.readFileSync(path.join(d, 'qemu.pid'), 'utf8'), 10);
          if (pid) process.kill(pid, 'SIGKILL');
        } catch {}
      }
    } catch {}
  };
  process.on('exit', cleanup);

  const up = await waitFor(async () => {
    try {
      const r = await request('GET', '/api/health');
      return r.status === 200;
    } catch {
      return false;
    }
  }, 10000);
  check('server start hua', up, srvOut.slice(-300));
  if (!up) return finish();

  console.log('\n[1] Auth');
  let r = await request('GET', '/api/vms');
  check('bina login 401 milta hai', r.status === 401);

  r = await request('POST', '/api/auth/setup', { password: 'testpass123' });
  check('setup password', r.status === 200, r.text);
  check('session cookie mila', !!cookie);

  r = await request('GET', '/api/vms');
  check('login ke baad /api/vms 200', r.status === 200);

  r = await request('GET', '/api/auth/state');
  check('auth state authed=true', r.json && r.json.authed === true);

  console.log('\n[2] System + images');
  r = await request('GET', '/api/system');
  check('system info mila', r.status === 200 && r.json.cpus > 0);
  check('qemu detect hua (mock)', r.json.qemu && /mock-qemu/.test(r.json.qemu.bin), JSON.stringify(r.json.qemu));
  check('kvm false dikh raha hai', r.json.accel === 'tcg');

  // test image upload (raw ISO-ish bytes)
  const fakeImg = Buffer.alloc(4096, 7);
  r = await request('POST', '/api/images/upload?name=test-base.img', fakeImg, true);
  check('image upload', r.status === 201 && r.json.image, r.text);
  const imageId = r.json.image && r.json.image.id;

  r = await request('GET', '/api/images');
  check('image list me hai', r.status === 200 && r.json.images.some((i) => i.id === imageId));
  check('catalog bhi aata hai', Array.isArray(r.json.catalog) && r.json.catalog.length >= 4);

  console.log('\n[3] VM create');
  r = await request('POST', '/api/vms', { name: 'demo-vps', imageId, cpu: 1, memMB: 512, diskGB: 5, user: 'ubuntu', password: 'secret12345' });
  check('VM create 201', r.status === 201, r.text);
  const vm = r.json && r.json.vm;
  check('VM ka id mila', !!(vm && vm.id));
  check('SSH port allot hua', vm && vm.sshPort >= 22000);
  check('password wapas aaya', vm && vm.password === 'secret12345');

  const vmDir = path.join(DATA, 'vms', vm.id);
  check('disk.qcow2 bana', fs.existsSync(path.join(vmDir, 'disk.qcow2')));
  const seed = path.join(vmDir, 'seed.iso');
  check('seed.iso bana', fs.existsSync(seed));
  const seedBuf = fs.readFileSync(seed);
  check('seed ISO magic (CD001)', seedBuf.slice(16 * 2048 + 1, 16 * 2048 + 6).toString() === 'CD001');
  check('seed volume id cidata', seedBuf.slice(16 * 2048 + 40, 16 * 2048 + 46).toString() === 'cidata');

  console.log('\n[4] Start / console');
  r = await request('POST', `/api/vms/${vm.id}/start`);
  check('start 200', r.status === 200, r.text);
  check('status running', r.json && r.json.vm.status.running === true, r.text);
  await sleep(400);
  check('qemu pid file mila', fs.existsSync(path.join(vmDir, 'qemu.pid')));

  const sse = await readSse(`/api/vms/${vm.id}/console`, 1600);
  check('console SSE se boot output aaya', /mock VM booting/.test(sse), sse.slice(0, 160));
  check('SSE hello event aaya', /event: hello/.test(sse));

  r = await request('POST', `/api/vms/${vm.id}/console`, { data: 'root\r' });
  check('console input accept hua', r.status === 200, r.text);

  r = await request('GET', '/api/vms');
  check('list me running dikhta hai', r.json.vms[0].status.running === true);

  console.log('\n[5] Snapshots');
  r = await request('GET', `/api/vms/${vm.id}/snapshots`);
  check('snapshot list (chalti VM)', r.status === 200 && r.json.snapshots.length === 1, r.text);
  r = await request('POST', `/api/vms/${vm.id}/snapshots`, { tag: 'clean-install' });
  check('snapshot create', r.status === 200, r.text);
  r = await request('POST', `/api/vms/${vm.id}/snapshots/clean-install/restore`);
  check('snapshot restore', r.status === 200, r.text);

  console.log('\n[6] Update / stop');
  r = await request('PATCH', `/api/vms/${vm.id}`, { cpu: 4 });
  check('chalti VM ka CPU change nahi hota', r.status === 409, r.text);

  r = await request('POST', `/api/vms/${vm.id}/stop`);
  check('stop 200', r.status === 200, r.text);
  const stopped = await waitFor(async () => {
    const x = await request('GET', `/api/vms/${vm.id}`);
    return x.json.vm.status.running === false;
  }, 8000);
  check('VM band ho gaya', stopped);
  check('pid file hat gaya', !fs.existsSync(path.join(vmDir, 'qemu.pid')));

  r = await request('PATCH', `/api/vms/${vm.id}`, { cpu: 4, memMB: 1024, notes: 'test note' });
  check('CPU/RAM update (stopped)', r.status === 200 && r.json.vm.cpu === 4, r.text);

  console.log('\n[7] Resize / clone / reinstall');
  r = await request('POST', `/api/vms/${vm.id}/resize`, { diskGB: 12 });
  check('disk resize', r.status === 200 && r.json.vm.diskGB === 12, r.text);

  r = await request('POST', `/api/vms/${vm.id}/clone`, { name: 'demo-copy' });
  check('clone bana', r.status === 201 && r.json.vm.name === 'demo-copy', r.text);
  const clone = r.json.vm;
  check('clone ka naya SSH port', clone.sshPort !== vm.sshPort);
  check('clone ka naya password', clone.password !== vm.password);
  check('clone disk bana', fs.existsSync(path.join(DATA, 'vms', clone.id, 'disk.qcow2')));

  r = await request('POST', `/api/vms/${vm.id}/reinstall`);
  check('reinstall', r.status === 200, r.text);

  console.log('\n[8] Share console + delete');
  r = await request('GET', `/api/public/console/${vm.shareToken}`);
  check('share token galat/band VM par 409', r.status === 409, String(r.status));

  r = await request('DELETE', `/api/vms/${clone.id}`);
  check('clone delete', r.status === 200, r.text);
  check('clone ka folder gaya', !fs.existsSync(path.join(DATA, 'vms', clone.id)));

  r = await request('DELETE', `/api/images/${imageId}`);
  check('use ho rahi image delete nahi hoti', r.status === 409, r.text);

  r = await request('DELETE', `/api/vms/${vm.id}`);
  check('VM delete', r.status === 200, r.text);

  r = await request('DELETE', `/api/images/${imageId}`);
  check('ab image delete ho gayi', r.status === 200, r.text);

  console.log('\n[9] Panel security');
  r = await request('POST', '/api/auth/login', { password: 'galat' });
  check('galat password 401', r.status === 401);
  r = await request('POST', '/api/settings', { sshHost: '1.2.3.4' }, false);
  check('settings save (same origin)', r.status === 200, r.text);

  finish();
}

function finish() {
  const total = pass + failures.length;
  console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${pass}/${total} checks pass${failures.length ? ' — FAILED: ' + failures.join(', ') : ''}\x1b[0m\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
