'use strict';
/**
 * Local LLM engine (llama.cpp ka llama-server).
 *  - model load / unload (child process, apna port)
 *  - OpenAI-compatible streaming chat
 *  - ya bahar ke server se bhi jud sakta hai (LLM_URL env)
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const store = require('./store');
const models = require('./models');
const { which, sleep, procInfo, pidAlive, hostMemMb } = require('./util');

const state = {
  mode: 'local', // local | external
  status: 'idle', // idle | starting | ready | error
  error: null,
  pid: null,
  startedAt: null,
  modelId: null,
  modelName: null,
  bin: null,
  logs: [],
  lastTokensPerSec: null,
  lastTimings: null
};

let child = null;
let starting = null;
const active = new Set(); // AbortControllers

function log(line) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  state.logs.push(text.slice(0, 400));
  if (state.logs.length > 400) state.logs.shift();
}

function baseUrl() {
  if (cfg.LLM_URL) return cfg.LLM_URL.replace(/\/+$/, '');
  return `http://127.0.0.1:${cfg.LLM_PORT}`;
}

async function resolveBinary() {
  if (process.env.LLM_BIN) return process.env.LLM_BIN;
  const inData = path.join(cfg.BIN_DIR, 'llama-server');
  try {
    await fsp.access(inData, fs.constants.X_OK);
    return inData;
  } catch {}
  const sys = await which('llama-server');
  if (sys) return sys;
  // build folder (agar source se build kiya ho)
  const guess = path.join(cfg.DATA_DIR, 'llama.cpp', 'build', 'bin', 'llama-server');
  try {
    await fsp.access(guess, fs.constants.X_OK);
    return guess;
  } catch {}
  return null;
}

async function engineInfo() {
  const bin = await resolveBinary();
  return {
    mode: cfg.LLM_URL ? 'external' : 'local',
    bin,
    ready: !!bin || !!cfg.LLM_URL
  };
}

async function healthz(timeout = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(`${baseUrl()}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    return true;
  } catch {
    return false;
  }
}

function status() {
  const info = procInfo(state.pid);
  return {
    mode: state.mode,
    status: state.status,
    error: state.error,
    pid: state.pid,
    alive: !!(info && info.alive),
    rss: info ? info.rss : 0,
    uptime: state.startedAt ? Date.now() - state.startedAt : 0,
    modelId: state.modelId,
    modelName: state.modelName || (state.mode === 'external' && state.status === 'ready' ? 'external engine' : null),
    url: baseUrl(),
    tokensPerSec: state.lastTokensPerSec,
    bin: state.bin,
    logs: state.logs.slice(-120)
  };
}

/** llama-server start karo (agar pehle se isi model se chal raha hai to skip) */
async function load(modelId, { force = false } = {}) {
  if (cfg.LLM_URL) {
    state.mode = 'external';
    state.status = 'ready';
    state.modelId = modelId || null;
    await store.update((s) => {
      s.settings.modelId = modelId || s.settings.modelId;
    });
    return status();
  }
  if (starting && !force) return starting;

  let wanted = modelId || store.get().settings.modelId;
  if (!wanted) {
    const pick = models.pickInstalled();
    if (pick) wanted = pick.id;
  }
  const model = models.get(wanted);
  if (!model)
    throw Object.assign(
      new Error('Koi model download nahi hai — Models page se Qwen2.5-Coder 1.5B download karein'),
      { status: 400, code: 'no_model_installed' }
    );

  const file = models.modelPath(model);
  try {
    await fsp.access(file, fs.constants.R_OK);
  } catch {
    throw Object.assign(new Error('Model file nahi mili — dobara download karein'), { status: 409 });
  }

  // RAM pre-flight: model VPS me fit hoga ya nahi
  try {
    const st = await fsp.stat(file);
    const needMb = Math.ceil((st.size * 1.15) / 1048576) + 512;
    const haveMb = hostMemMb();
    if (needMb > haveMb) {
      throw Object.assign(
        new Error(
          `Ye model ~${(needMb / 1024).toFixed(1)} GB RAM maangta hai, is VPS me ${(haveMb / 1024).toFixed(1)} GB hai. ` +
            'Chhota model download karein (Qwen2.5-Coder 1.5B) — warna panel OOM se band ho sakta hai.'
        ),
        { status: 507 }
      );
    }
    log(`ram check: need ~${needMb} MB, available ${haveMb} MB`);
  } catch (e) {
    if (e.status) throw e;
  }

  const bin = await resolveBinary();
  if (!bin) {
    throw Object.assign(
      new Error('llama-server nahi mila. Installer chalayein: sudo bash scripts/install.sh (ya LLM_BIN set karein)'),
      { status: 503 }
    );
  }

  if (state.pid && pidAlive(state.pid) && state.modelId === model.id && !force) {
    if (await healthz()) return status();
  }

  await stop();

  starting = (async () => {
    state.status = 'starting';
    state.error = null;
    state.bin = bin;
    state.logs = [];
    const args = [
      '-m', file,
      '--host', cfg.LLM_HOST,
      '--port', String(cfg.LLM_PORT),
      '-c', String(store.get().settings.ctxSize || cfg.CTX_SIZE),
      '-t', String(cfg.THREADS),
      '--parallel', '1',
      '--metrics'
    ];
    log(`$ ${bin} ${args.join(' ')}`);
    child = spawn(bin, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    state.pid = child.pid;
    child.stdout.on('data', (d) => String(d).split('\n').forEach(log));
    child.stderr.on('data', (d) => String(d).split('\n').forEach(log));
    child.on('exit', (code, sig) => {
      log(`llama-server exit (code ${code}${sig ? ', ' + sig : ''})`);
      state.status = 'idle';
      state.pid = null;
      child = null;
      if (state.modelId) state.error = `Engine band ho gaya (code ${code}) — model VPS ki RAM me fit nahi ho raha hoga.`;
    });

    const deadline = Date.now() + cfg.LLM_START_TIMEOUT;
    while (Date.now() < deadline) {
      if (!child || !pidAlive(state.pid)) {
        state.status = 'error';
        state.error = state.error || 'Engine start hi nahi hua — logs dekhein';
        starting = null;
        return status();
      }
      if (await healthz(1200)) {
        state.status = 'ready';
        state.startedAt = Date.now();
        state.modelId = model.id;
        state.modelName = model.name;
        await store.update((s) => {
          s.settings.modelId = model.id;
        });
        starting = null;
        log('engine ready');
        return status();
      }
      await sleep(700);
    }
    state.status = 'error';
    state.error = 'Model load hone me bahut zyada time laga (180s). Chhota model try karein.';
    starting = null;
    return status();
  })();

  return starting;
}

async function stop() {
  if (starting) {
    try {
      await starting;
    } catch {}
  }
  if (child && state.pid) {
    const pid = state.pid;
    try {
      child.kill('SIGTERM');
    } catch {}
    for (let i = 0; i < 40; i++) {
      if (!pidAlive(pid)) break;
      await sleep(150);
    }
    if (pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  child = null;
  state.pid = null;
  state.status = 'idle';
  state.modelId = null;
  state.modelName = null;
  state.startedAt = null;
  return status();
}

/**
 * Streaming chat. onToken(text) har delta par, onDone({finish, timings}).
 */
async function chat({ messages, temperature, maxTokens, stop: stopSeq, signal, onToken }) {
  if (!(await healthz(1500))) {
    if (state.status !== 'starting') {
      const pick = models.pickInstalled();
      throw Object.assign(new Error('Model load nahi hai — Models page se model load karein'), {
        status: 503,
        code: 'engine_not_loaded',
        modelId: pick ? pick.id : null,
        modelName: pick ? pick.name : null
      });
    }
  }
  const ctrl = new AbortController();
  active.add(ctrl);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort);

  const body = {
    messages,
    stream: true,
    temperature: typeof temperature === 'number' ? temperature : cfg.TEMPERATURE,
    max_tokens: maxTokens || cfg.DEFAULT_MAX_TOKENS,
    cache_prompt: true
  };
  if (Array.isArray(stopSeq) && stopSeq.length) body.stop = stopSeq;

  let res;
  try {
    res = await fetch(`${baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    active.delete(ctrl);
    if (e.name === 'AbortError') return { aborted: true, text: '' };
    throw new Error(`Engine se connect nahi hua: ${e.message}`);
  }

  if (!res.ok) {
    active.delete(ctrl);
    const txt = await res.text().catch(() => '');
    throw new Error(`Engine error ${res.status}: ${txt.slice(0, 300)}`);
  }

  let text = '';
  let timings = null;
  let finish = null;
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = obj.choices && obj.choices[0];
        const delta = choice && choice.delta && choice.delta.content;
        if (delta) {
          text += delta;
          onToken && onToken(delta);
        }
        if (choice && choice.finish_reason) finish = choice.finish_reason;
        if (obj.timings) {
          timings = obj.timings;
          if (obj.timings.predicted_per_second) {
            state.lastTokensPerSec = Math.round(obj.timings.predicted_per_second * 10) / 10;
            state.lastTimings = obj.timings;
          }
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
    return { aborted: true, text, timings };
  } finally {
    active.delete(ctrl);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  return { text, timings, finish };
}

function stopAll() {
  for (const c of active) {
    try {
      c.abort();
    } catch {}
  }
  active.clear();
}

/** panel boot par: agar model selected hai to load kar do (optional) */
async function autostart() {
  const st = store.get();
  if (cfg.LLM_URL) {
    state.mode = 'external';
    state.status = (await healthz(2000)) ? 'ready' : 'error';
    state.error = state.status === 'ready' ? null : `${cfg.LLM_URL} se connect nahi hua`;
    return;
  }
  let wantId = st.settings.modelId;
  if (!wantId) {
    // fresh install: disk par jo model pada hai use hi chuno aur load karo
    try {
      await models.refreshFromDisk();
    } catch {}
    const pick = models.pickInstalled();
    if (!pick) {
      log('koi model nahi mila — Models page se download karein');
      return;
    }
    wantId = pick.id;
    await store.update((s) => {
      s.settings.modelId = pick.id;
    });
    log(`auto-select model: ${pick.name}`);
  }
  const m = models.get(wantId);
  if (!m) return;
  try {
    await load(m.id);
  } catch (e) {
    state.status = 'error';
    state.error = e.message;
  }
}

module.exports = { status, load, stop, chat, stopAll, autostart, healthz, engineInfo, baseUrl, state };
