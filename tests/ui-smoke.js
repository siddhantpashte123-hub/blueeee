#!/usr/bin/env node
'use strict';
/**
 * UI smoke test (jsdom) — login → chat → streaming → apply → editor → preview → modals.
 *   npm i --no-save jsdom && node tests/ui-smoke.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), `forge-ui-${Date.now()}`);
const PORT = 4700 + Math.floor(Math.random() * 200);
const LLM_PORT = PORT + 500;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ' — ' + String(extra).slice(0, 240) : ''}`);
  }
}

let cookie = '';
function httpReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers: Object.assign(
          {},
          cookie ? { Cookie: cookie } : {},
          data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
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
async function waitFor(fn, timeout = 12000, step = 150) {
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
  let JSDOM, VirtualConsole;
  try {
    ({ JSDOM, VirtualConsole } = require('jsdom'));
  } catch {
    console.log('jsdom nahi hai — npm i --no-save jsdom');
    process.exit(2);
  }
  await fsp.mkdir(DATA, { recursive: true });

  const mock = spawn(process.execPath, [path.join(ROOT, 'tests/mock-llm.js'), String(LLM_PORT)], { stdio: 'ignore' });
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LLM_URL: `http://127.0.0.1:${LLM_PORT}`
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvOut = '';
  server.stdout.on('data', (d) => (srvOut += d));
  server.stderr.on('data', (d) => (srvOut += d));
  const cleanup = () => {
    try {
      server.kill('SIGTERM');
    } catch {}
    try {
      mock.kill('SIGTERM');
    } catch {}
  };
  process.on('exit', cleanup);

  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await httpReq('GET', '/api/health');
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {}
    await sleep(150);
  }
  check('panel start hua', up, srvOut.slice(-200));
  if (!up) return finish();

  await httpReq('POST', '/api/auth/setup', { password: 'forge123456' });
  cookie = ''; // login screen test karne ke liye

  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    if (!/Not implemented/.test(e.message)) console.log('  [jsdom]', e.message);
  });

  const dom = new JSDOM(await fsp.readFile(path.join(ROOT, 'public/index.html'), 'utf8'), {
    url: `${BASE}/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = (url, opts = {}) => {
        const abs = String(url).startsWith('http') ? String(url) : BASE + String(url);
        const headers = Object.assign({}, opts.headers || {});
        if (cookie) headers['Cookie'] = cookie;
        return globalThis.fetch(abs, Object.assign({}, opts, { headers })).then((res) => {
          const sc = res.headers.get('set-cookie');
          if (sc) cookie = sc.split(';')[0];
          return res;
        });
      };
      window.navigator.clipboard = { writeText: () => Promise.resolve() };
      window.confirm = () => true;
      window.prompt = (_m, def) => def || 'renamed';
      window.HTMLElement.prototype.scrollTo = function () {};
    }
  });

  const w = dom.window;
  const doc = w.document;
  const script = doc.createElement('script');
  script.textContent = await fsp.readFile(path.join(ROOT, 'public/assets/app.js'), 'utf8');
  doc.body.appendChild(script);
  await sleep(700);

  console.log('\n[1] Login');
  check('login card dikha', !!doc.querySelector('.auth-card'));
  doc.querySelector('#pw').value = 'forge123456';
  doc.querySelector('#auth-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const loggedIn = await waitFor(() => !!doc.querySelector('.app-shell'), 9000);
  check('login ke baad studio khula', loggedIn);
  check('sidebar hai', !!doc.querySelector('.sidebar'));
  check('composer hai', !!doc.querySelector('#prompt'));
  check('workspace panel hai', !!doc.querySelector('.aside'));
  check('empty state suggestions hain', doc.querySelectorAll('.sugg').length >= 4);

  console.log('\n[2] Chat + streaming');
  check('engine chip ready hai', /ready|model/i.test(doc.querySelector('#top-stats').textContent));
  const ta = doc.querySelector('#prompt');
  ta.value = 'Ek landing page banao';
  doc.querySelector('#btn-send').click();
  const gotCode = await waitFor(() => !!doc.querySelector('.code-block'), 15000);
  check('stream ke baad code block aaya', gotCode);
  check('code block par path badge hai', !!doc.querySelector('.code-head .path'));
  check('apply button hai', !!doc.querySelector('[data-apply]'));
  const finished = await waitFor(() => !doc.querySelector('#btn-stop') || doc.querySelector('#btn-stop').style.display === 'none', 15000);
  check('stream khatam hua', finished);
  check('user message dikha', doc.querySelectorAll('.msg.user').length >= 1);
  const chatCount = (await httpReq('GET', '/api/chats')).json.chats.length;
  check('chat save hua', chatCount >= 1, String(chatCount));

  console.log('\n[3] Apply file → workspace');
  const applyBtns = Array.from(doc.querySelectorAll('[data-apply]'));
  check('3 apply buttons hain (multi-file)', applyBtns.length >= 3, String(applyBtns.length));
  for (const b of applyBtns) {
    b.click();
    await sleep(250);
  }
  const treeHasFile = await waitFor(async () => {
    const r = await httpReq('GET', '/api/files');
    return r.json.tree.some((e) => e.path === 'index.html');
  }, 8000);
  check('file workspace me aa gayi', treeHasFile);
  // apply ke baad app preview tab kholta hai — settle hone do, phir Files tab
  await sleep(900);
  const filesTab = Array.from(doc.querySelectorAll('.aside-tabs button')).find((b) => b.dataset.tab === 'files');
  if (filesTab) filesTab.click();
  await waitFor(() => doc.querySelectorAll('.tree-row').length > 0, 6000);
  check('tree me rows dikh rahe hain', doc.querySelectorAll('.tree-row').length >= 3, String(doc.querySelectorAll('.tree-row').length));

  const fileRow = Array.from(doc.querySelectorAll('.tree-row')).find((r) => /index\.html/.test(r.textContent));
  check('index.html tree me hai', !!fileRow);
  if (fileRow) {
    fileRow.click();
    await waitFor(() => !!doc.querySelector('#file-content'), 6000);
    check('editor khula', !!doc.querySelector('#file-content'));
    check('editor me content hai', (doc.querySelector('#file-content') || {}).value?.includes('Forge se bana') || false);
    const saveBtn = doc.querySelector('#file-save');
    check('save button hai', !!saveBtn);
  }

  console.log('\n[4] Preview');
  const pvTab = Array.from(doc.querySelectorAll('.aside-tabs button')).find((b) => b.dataset.tab === 'preview');
  if (pvTab) pvTab.click();
  const frame = await waitFor(() => !!doc.querySelector('#pv-frame'), 8000);
  check('preview iframe aaya', frame);
  check('iframe sandbox hai', (doc.querySelector('#pv-frame') || {}).getAttribute?.('sandbox')?.includes('allow-scripts') || false);
  const pvSrc = (doc.querySelector('#pv-frame') || {}).srcdoc || '';
  check('preview me html render hua', /Forge se bana page/.test(pvSrc), pvSrc.slice(0, 80));

  console.log('\n[5] Modals');
  doc.querySelector('#btn-models').click();
  await waitFor(() => !!doc.querySelector('.model-card'), 6000);
  check('models modal khula', !!doc.querySelector('.model-card'));
  check('5 model cards hain', doc.querySelectorAll('.model-card').length >= 5, String(doc.querySelectorAll('.model-card').length));
  check('download buttons hain', doc.querySelectorAll('[data-dl]').length >= 4);
  const closeBtn = doc.querySelector('#m-close');
  if (closeBtn) closeBtn.click();
  await sleep(200);
  check('models modal band hua', !doc.querySelector('.model-card'));

  doc.querySelector('#btn-settings').click();
  await sleep(300);
  check('settings modal khula', !!doc.querySelector('#s-temp'));
  check('temperature slider hai', !!doc.querySelector('#s-temp'));
  const sClose = doc.querySelector('#s-close');
  if (sClose) sClose.click();

  console.log('\n[6] Chats + presets');
  check('preset selector bhara hai', doc.querySelectorAll('#preset option').length >= 5);
  doc.querySelector('#btn-newchat').click();
  await sleep(300);
  check('naya chat khula', !!doc.querySelector('.empty-chat'));
  check('chat list me item hai', doc.querySelectorAll('.chat-item').length >= 1);

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
