#!/usr/bin/env node
'use strict';
/**
 * Forge API integration test — mock LLM engine ke saath.
 *   node tests/api-test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), `forge-test-${Date.now()}`);
const PORT = 4300 + Math.floor(Math.random() * 300);
const LLM_PORT = PORT + 900 > 60000 ? 4099 : PORT + 900;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`);
  }
}

let cookie = '';

function request(method, urlPath, body) {
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

/** POST /api/chat aur SSE events collect karo */
function chatStream(payload) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload));
    const events = [];
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Cookie: cookie }
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                events.push(JSON.parse(line.slice(5).trim()));
              } catch {}
            }
          }
        });
        res.on('end', () => resolve(events));
      }
    );
    req.on('error', () => resolve(events));
    req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fsp.mkdir(DATA, { recursive: true });

  const mock = spawn(process.execPath, [path.join(ROOT, 'tests/mock-llm.js'), String(LLM_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let mockOut = '';
  mock.stdout.on('data', (d) => (mockOut += d));

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

  // wait for panel
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await request('GET', '/api/health');
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {}
    await sleep(150);
  }
  check('panel start hua', up, srvOut.slice(-300));
  if (!up) return finish();

  console.log('\n[1] Auth');
  check('bina login 401', (await request('GET', '/api/files')).status === 401);
  let r = await request('POST', '/api/auth/setup', { password: 'forge123456' });
  check('setup password', r.status === 200, r.text);
  check('session cookie mila', !!cookie);
  r = await request('GET', '/api/auth/state');
  check('auth state authed', r.json.authed === true);

  console.log('\n[2] System + engine');
  r = await request('GET', '/api/system');
  check('system 200', r.status === 200);
  check('engine external mode', r.json.engine.mode === 'external', JSON.stringify(r.json.engine.mode));
  check('engine ready (mock)', r.json.engine.status === 'ready', r.json.engine.status);
  check('presets aate hain', Array.isArray(r.json.presets) && r.json.presets.length >= 5);

  console.log('\n[3] Models');
  r = await request('GET', '/api/models');
  check('model catalog 200', r.status === 200 && Array.isArray(r.json.catalog));
  check('catalog me 5 models', r.json.catalog.length === 5, r.json.catalog.length);
  check('recommended model mila', !!r.json.recommend);
  const badUrl = await request('POST', '/api/models/download', { url: 'file:///etc/passwd' });
  check('non-http URL block', badUrl.status === 400, badUrl.text);

  console.log('\n[4] Chat streaming');
  let events = await chatStream({ message: 'Ek landing page banao', preset: 'engineer' });
  const tokens = events.filter((e) => e.type === 'token').map((e) => e.t).join('');
  const done = events.find((e) => e.type === 'done');
  const start = events.find((e) => e.type === 'start');
  check('start event aaya', !!start && !!start.chatId);
  check('token stream aaya', tokens.length > 50, String(tokens.length));
  check('done event aaya', !!done);
  check('done me files list hai', done && Array.isArray(done.files) && done.files.includes('index.html'), JSON.stringify(done && done.files));
  check('tokens/sec report hua', done && done.tokensPerSec > 0, done && done.tokensPerSec);

  const chatId = start.chatId;
  r = await request('GET', `/api/chats/${chatId}`);
  check('chat save hua (2 messages)', r.json.chat.messages.length === 2, r.json.chat.messages.length);
  check('assistant message me code hai', /```html path=index\.html/.test(r.json.chat.messages[1].content));

  r = await request('GET', '/api/chats');
  check('chat list me hai', r.json.chats.some((c) => c.id === chatId));

  console.log('\n[5] Files apply / read / edit');
  // text se apply
  const chat = (await request('GET', `/api/chats/${chatId}`)).json.chat;
  r = await request('POST', '/api/files/apply', { text: chat.messages[1].content });
  check('apply ne files likhi', r.status === 200 && r.json.files.length === 3, r.text);

  r = await request('GET', '/api/files');
  const paths = r.json.tree.filter((e) => e.type === 'file').map((e) => e.path);
  check('tree me index.html', paths.includes('index.html'), paths.join(','));
  check('tree me style.css', paths.includes('style.css'), paths.join(','));
  check('tree me app.js', paths.includes('app.js'), paths.join(','));

  r = await request('GET', '/api/file?path=index.html');
  check('file padhi ja rahi hai', r.status === 200 && /Forge se bana page/.test(r.json.content));

  r = await request('PUT', '/api/file', { path: 'notes.md', content: '# notes\nedited' });
  check('file save hui', r.status === 200, r.text);
  r = await request('GET', '/api/file?path=notes.md');
  check('edit persist hua', r.json.content === '# notes\nedited');

  r = await request('DELETE', '/api/file?path=notes.md');
  check('file delete hui', r.status === 200);

  const trav = await request('PUT', '/api/file', { path: '../../etc/passwd', content: 'x' });
  check('path traversal block', trav.status === 400 || trav.status === 404, String(trav.status));

  console.log('\n[6] Preview + zip');
  r = await request('GET', '/api/preview');
  check('preview html mila', r.status === 200 && !!r.json.html, r.text.slice(0, 120));
  check('css inline hua', /\.hero\s*\{/.test(r.json.html || ''), (r.json && r.json.html || '').slice(0, 200));
  check('js inline hua', /addEventListener/.test(r.json.html || ''));

  r = await request('GET', '/api/files/zip');
  check('zip download', r.status === 200 && r.text.startsWith('PK'), r.status);
  check('zip me file name hai', r.text.includes('index.html'));
  await fsp.writeFile(path.join(DATA, 'test.zip'), Buffer.from(r.text, 'binary'));

  console.log('\n[7] Chats management');
  r = await request('POST', '/api/chats', { title: 'Doosra chat' });
  check('naya chat bana', r.status === 201 && !!r.json.chat.id);
  r = await request('PATCH', `/api/chats/${r.json.chat.id}`, { title: 'Renamed' });
  check('chat rename', r.status === 200 && r.json.chat.title === 'Renamed');
  r = await request('DELETE', `/api/chats/${r.json.chat.id}`);
  check('chat delete', r.status === 200);

  console.log('\n[8] Stop generation');
  const t0 = Date.now();
  const slowPromise = chatStream({ message: 'SLOW test please', preset: 'engineer' });
  await sleep(400);
  const stopRes = await request('POST', '/api/chat/stop');
  check('stop API ok', stopRes.status === 200);
  const slowEvents = await slowPromise;
  const slowDone = slowEvents.find((e) => e.type === 'done');
  check('stream jaldi ruka', Date.now() - t0 < 8000, `${Date.now() - t0}ms`);
  check('aborted flag mila', !!slowDone && slowDone.aborted === true, JSON.stringify(slowDone && slowDone.aborted));

  console.log('\n[9] Settings / security');
  r = await request('POST', '/api/settings', { temperature: 0.7, maxTokens: 2048 });
  check('settings save', r.status === 200 && r.json.settings.temperature === 0.7, r.text);
  r = await request('POST', '/api/settings', { temperature: 99 });
  check('temperature clamp hua', r.json.settings.temperature <= 1.5, r.json.settings.temperature);
  r = await request('POST', '/api/auth/login', { password: 'wrong' });
  check('galat password 401', r.status === 401);
  r = await request('GET', '/api/nope');
  check('unknown API 404', r.status === 404);

  finish();
}

function finish() {
  const total = pass + failures.length;
  console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${pass}/${total} API checks pass${failures.length ? ' — FAILED: ' + failures.join(', ') : ''}\x1b[0m\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
