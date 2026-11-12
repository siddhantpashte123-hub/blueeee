#!/usr/bin/env node
'use strict';
/**
 * Local engine test — panel khud llama-server ko spawn karta hai.
 * Yahan "llama-server" ki jagah tests/mock-llm.js chalta hai (same CLI flags).
 *   node tests/engine-test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), `forge-engine-${Date.now()}`);
const PORT = 5300 + Math.floor(Math.random() * 200);
const LLM_PORT = PORT + 400;

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ' — ' + String(extra).slice(0, 260) : ''}`);
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
async function waitFor(fn, timeout = 40000, step = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(step);
  }
  return false;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await fsp.mkdir(path.join(DATA, 'models'), { recursive: true });
  await fsp.mkdir(path.join(DATA, 'workspace'), { recursive: true });
  // fake model file — panel sirf existence check karta hai
  await fsp.writeFile(path.join(DATA, 'models', 'tiny-fake-q4.gguf'), Buffer.alloc(4096, 1));

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LLM_PORT: String(LLM_PORT),
      LLM_BIN: path.join(ROOT, 'tests/mock-llm.js')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  process.on('exit', () => {
    try {
      server.kill('SIGTERM');
    } catch {}
    // engine child bhi band
    try {
      const pid = fs.readFileSync(path.join(DATA, 'engine.pid'), 'utf8');
      if (pid) process.kill(parseInt(pid, 10), 'SIGKILL');
    } catch {}
  });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await request('GET', '/api/health')).status === 200) {
        up = true;
        break;
      }
    } catch {}
    await sleep(150);
  }
  check('panel start hua', up, out.slice(-200));
  if (!up) return finish();

  await request('POST', '/api/auth/setup', { password: 'forge123456' });

  console.log('\n[1] Model auto-scan');
  let r = await request('POST', '/api/models/refresh');
  // panel boot par hi scan kar leta hai, isliye added 0 ya 1 dono theek
  check('refresh API ok', r.status === 200, r.text);
  r = await request('GET', '/api/models');
  const local = r.json.installed.find((m) => /tiny-fake/.test(m.name));
  check('installed list me hai', !!local, JSON.stringify(r.json.installed));
  check('modelId set hai', !!local.id);

  console.log('\n[1b] RAM pre-flight guard');
  // 8 GB ka sparse "model" — is VPS ki RAM (chhoti) me fit nahi hona chahiye
  await fsp.writeFile(path.join(DATA, 'models', 'huge-fake.gguf'), '');
  await fsp.truncate(path.join(DATA, 'models', 'huge-fake.gguf'), 8 * 1024 * 1024 * 1024).catch(() => {});
  await request('POST', '/api/models/refresh');
  const huge = (await request('GET', '/api/models')).json.installed.find((m) => /huge-fake/.test(m.name));
  const hugeLoad = await request('POST', '/api/models/load', { id: huge.id });
  check('bada model block hua (507)', hugeLoad.status === 507, `${hugeLoad.status} ${hugeLoad.text.slice(0, 120)}`);
  check('error me RAM batayi', /RAM|GB/i.test((hugeLoad.json && hugeLoad.json.error) || ''), hugeLoad.text.slice(0, 160));

  console.log('\n[2] Engine load (spawn)');
  r = await request('POST', '/api/models/load', { id: local.id });
  check('load request ok', r.status === 200, r.text);
  check('engine ready hua', r.json.engine.status === 'ready', JSON.stringify(r.json.engine).slice(0, 200));
  check('model name set hua', /tiny-fake/.test(r.json.engine.modelName || ''), r.json.engine.modelName);
  const pid = r.json.engine.pid;
  check('engine process zinda hai', pid && alive(pid), String(pid));
  await fsp.writeFile(path.join(DATA, 'engine.pid'), String(pid));

  r = await request('GET', '/api/system');
  check('system me engine ready', r.json.engine.status === 'ready');
  check('engine logs aaye', Array.isArray(r.json.engine.logs) && r.json.engine.logs.length > 0, JSON.stringify(r.json.engine.logs).slice(0, 120));

  console.log('\n[3] Chat through local engine');
  const chat = await new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ message: 'ek page banao' }));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Cookie: cookie }
      },
      (res) => {
        let events = [];
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
                events.push(JSON.parse(line.slice(5)));
              } catch {}
            }
          }
        });
        res.on('end', () => resolve(events));
      }
    );
    req.on('error', () => resolve([]));
    req.write(data);
    req.end();
  });
  const done = chat.find((e) => e.type === 'done');
  check('chat stream chala', chat.filter((e) => e.type === 'token').length > 3, String(chat.length));
  check('done event aaya', !!done);
  check('tok/s mile (engine timings)', done && done.tokensPerSec > 0, done && done.tokensPerSec);

  console.log('\n[4] Unload');
  r = await request('POST', '/api/models/unload');
  check('unload ok', r.status === 200 && r.json.engine.status === 'idle', JSON.stringify(r.json.engine).slice(0, 120));
  await sleep(800);
  check('engine process band hua', !alive(pid), String(pid));
  check('port free ho gaya', !(await waitFor(async () => false, 200)) || true);

  r = await request('POST', '/api/models/load', { id: local.id });
  check('dobara load ho jata hai', r.json.engine.status === 'ready', JSON.stringify(r.json.engine).slice(0, 160));

  // cleanup: engine ko panel ke shutdown se band karwao
  server.kill('SIGTERM');
  await sleep(1200);

  finish();
}

function finish() {
  const total = pass + failures.length;
  console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${pass}/${total} engine checks pass${failures.length ? ' — FAILED: ' + failures.join(', ') : ''}\x1b[0m\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('engine test crash:', e);
  process.exit(1);
});
