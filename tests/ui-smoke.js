#!/usr/bin/env node
'use strict';
/**
 * UI smoke test (jsdom): login → dashboard → VM page → images → settings → share console.
 * Chalane ke liye: npm i --no-save jsdom && node tests/ui-smoke.js
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), `vpsdeck-ui-${Date.now()}`);
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ' — ' + String(extra).slice(0, 220) : ''}`);
  }
}

let cookie = '';
function httpReq(method, urlPath, body, raw = false) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers: Object.assign(
          {},
          cookie ? { Cookie: cookie } : {},
          data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}
        )
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          const sc = res.headers['set-cookie'];
          if (sc && sc[0]) cookie = sc[0].split(';')[0];
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeout = 8000, step = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch {}
    await sleep(step);
  }
  return false;
}

async function main() {
  let JSDOM;
  try {
    JSDOM = require('jsdom').JSDOM;
  } catch {
    console.log('jsdom install nahi hai — chalao: npm i --no-save jsdom');
    process.exit(2);
  }
  await fsp.mkdir(DATA, { recursive: true });

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
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const cleanup = () => {
    try {
      server.kill('SIGTERM');
    } catch {}
    try {
      for (const v of fs.readdirSync(path.join(DATA, 'vms'))) {
        try {
          const pid = parseInt(fs.readFileSync(path.join(DATA, 'vms', v, 'qemu.pid'), 'utf8'), 10);
          if (pid) process.kill(pid, 'SIGKILL');
        } catch {}
      }
    } catch {}
  };
  process.on('exit', cleanup);

  const ok = await waitUntil(async () => false, 300);
  // server up?
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await httpReq('GET', '/api/health');
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {}
    await sleep(150);
  }
  check('panel start hua', up, log.slice(-200));
  if (!up) return finish();

  // seed data via API
  await httpReq('POST', '/api/auth/setup', { password: 'testpass123' });
  const img = Buffer.alloc(4096, 3);
  const up2 = await httpReq('POST', '/api/images/upload?name=ui-base.img', img, true);
  const imageId = up2.json.image.id;
  const created = await httpReq('POST', '/api/vms', {
    name: 'ui-demo',
    imageId,
    cpu: 2,
    memMB: 512,
    diskGB: 5,
    user: 'ubuntu',
    password: 'secret12345'
  });
  const vm = created.json.vm;
  await httpReq('POST', `/api/vms/${vm.id}/start`);
  await sleep(600);

  // jsdom boot — pehle cookie clear, taaki login screen test ho
  cookie = '';
  const { VirtualConsole } = require('jsdom');
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.log('  [jsdom error]', e.message));
  vc.on('error', (...a) => console.log('  [console.error]', ...a));
  const dom = new JSDOM(await fsp.readFile(path.join(ROOT, 'public/index.html'), 'utf8'), {
    url: `${BASE}/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: undefined,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = (url, opts = {}) => {
        const abs = String(url).startsWith('http') ? String(url) : BASE + String(url);
        const headers = Object.assign({}, opts.headers || {});
        if (cookie) headers['Cookie'] = cookie;
        return globalThis
          .fetch(abs, Object.assign({}, opts, { headers }))
          .then((res) => {
            if (process.env.UI_DEBUG) console.log('   fetch', String(url), res.status);
            const sc = res.headers.get('set-cookie');
            if (sc) cookie = sc.split(';')[0];
            return res;
          });
      };
      window.navigator.clipboard = { writeText: () => Promise.resolve() };
      window.EventSource = class {
        constructor(url) {
          this.url = url;
          this.readyState = 1;
          setTimeout(() => this.onopen && this.onopen({}), 5);
        }
        addEventListener() {}
        close() {
          this.readyState = 2;
        }
      };
      window.HTMLElement.prototype.scrollTo = function () {};
    }
  });

  const w = dom.window;
  const doc = w.document;
  // app.js manually inject (jsdom resources se external script load nahi karta)
  const scriptEl = doc.createElement('script');
  scriptEl.textContent = await fsp.readFile(path.join(ROOT, 'public/assets/app.js'), 'utf8');
  doc.body.appendChild(scriptEl);
  // app.js boot() turant chalta hai; thoda time do
  await sleep(700);

  console.log('\n[1] Login screen');
  check('login card dikha (session nahi tha)', !!doc.querySelector('.login-card'));
  check('password field hai', !!doc.querySelector('#pw'));
  doc.querySelector('#pw').value = 'testpass123';
  doc.querySelector('#login-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const loggedIn = await waitUntil(() => !!doc.querySelector('.topbar'), 6000);
  check('login ke baad topbar aaya', loggedIn);
  check('VM ka naam dashboard par hai', /ui-demo/.test(doc.body.textContent || ''));

  console.log('\n[2] Dashboard');
  check('"Naya VPS" button hai', !!Array.from(doc.querySelectorAll('button')).find((b) => /Naya VPS/.test(b.textContent)));
  check('stats cards hain', doc.querySelectorAll('.stat').length >= 3);
  check('VM card ka status green hai', !!doc.querySelector('.vm-card .badge.green'));

  const newBtn = Array.from(doc.querySelectorAll('button')).find((b) => /Naya VPS/.test(b.textContent));
  newBtn.click();
  await sleep(600);
  const modal = doc.querySelector('.modal-back');
  check('create modal khula', !!modal);
  check('modal me image select hai', !!(modal && modal.querySelector('select[name=imageId]')));
  check('modal me password prefilled hai', !!(modal && modal.querySelector('input[name=password]').value.length >= 8));
  if (modal) modal.querySelector('[data-close]').click();

  console.log('\n[3] VM detail');
  w.location.hash = `#/vm/${vm.id}`;
  await sleep(800);
  check('VM detail khula', !!doc.querySelector('#term-body'));
  check('SSH command dikh raha hai', /ssh -p \d+/.test(doc.body.textContent || ''));
  check('share link hai', !!doc.querySelector('#share-url') && doc.querySelector('#share-url').value.includes('/#/console/'));
  check('settings form hai', !!doc.querySelector('#vm-settings'));
  check('console terminal focusable hai', !!doc.querySelector('#term-body').getAttribute('tabindex'));

  // terminal key input -> POST (should not throw)
  const term = doc.querySelector('#term-body');
  const ev = new w.KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true });
  term.dispatchEvent(ev);
  check('terminal keydown handle hua', ev.defaultPrevented);

  console.log('\n[4] Images');
  w.location.hash = '#/images';
  await sleep(800);
  check('images page khula', /OS Images/.test(doc.body.textContent || ''));
  check('catalog cards dikhe', doc.querySelectorAll('[data-dl]').length >= 3);
  check('upload input hai', !!doc.querySelector('#iso-file'));

  console.log('\n[5] Settings');
  w.location.hash = '#/settings';
  await sleep(700);
  check('settings page khula', !!doc.querySelector('#set-form'));
  check('host info dikh rahi hai', /QEMU/.test(doc.body.textContent || ''));
  check('password form hai', !!doc.querySelector('#pw-form'));

  console.log('\n[6] Public console (share link)');
  w.location.hash = `#/console/${vm.shareToken}`;
  await sleep(700);
  check('share console page khula', !!doc.querySelector('.term-body'));
  check('share page par panel nav nahi hai', !doc.querySelector('.nav'));

  console.log('\n[7] XSS safe rendering');
  await httpReq('POST', '/api/vms', {
    name: 'xss-test',
    imageId,
    cpu: 1,
    memMB: 256,
    diskGB: 2,
    user: 'ubuntu',
    password: 'secret12345'
  });
  const bad = await httpReq('POST', '/api/vms', { name: 'tmp', imageId, cpu: 1, memMB: 256, diskGB: 2 });
  await httpReq('PATCH', `/api/vms/${bad.json.vm.id}`, { name: '<img src=x onerror=alert(1)>' });
  w.location.hash = '#/';
  await sleep(900);
  check('naam HTML inject nahi hua', !doc.querySelector('img[onerror]'));

  dom.window.close();
  finish();
}

function finish() {
  const total = pass + failures.length;
  console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${pass}/${total} UI checks pass${failures.length ? ' — FAILED: ' + failures.join(', ') : ''}\x1b[0m\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('UI test crash:', e);
  process.exit(1);
});
