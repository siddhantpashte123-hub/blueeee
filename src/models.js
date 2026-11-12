'use strict';
/**
 * Model manager: catalog, download (progress ke saath), delete, local .gguf scan.
 * Sab GGUF models llama.cpp par chalte hain — CPU par bhi.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const cfg = require('./config');
const store = require('./store');
const { ensureDir, fileSize, fmtBytes, hostMemMb, exists } = require('./util');

const HF = 'https://huggingface.co';

const CATALOG = [
  {
    id: 'qwen2.5-coder-1.5b',
    name: 'Qwen2.5 Coder 1.5B',
    params: '1.5B',
    quant: 'Q4_K_M',
    sizeGB: 1.0,
    ramGB: 3,
    note: 'Sabse tez — 2-4 GB RAM wale VPS ke liye. Chhote functions, scripts, HTML/CSS ke liye badhiya.',
    recommendedFor: 4,
    url: `${HF}/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf?download=true`,
    filename: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'
  },
  {
    id: 'qwen2.5-coder-3b',
    name: 'Qwen2.5 Coder 3B',
    params: '3B',
    quant: 'Q4_K_M',
    sizeGB: 1.9,
    ramGB: 5,
    note: 'Sweets spot — 8 GB RAM par poore projects likh sakta hai.',
    recommendedFor: 8,
    url: `${HF}/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf?download=true`,
    filename: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf'
  },
  {
    id: 'qwen2.5-coder-7b',
    name: 'Qwen2.5 Coder 7B',
    params: '7B',
    quant: 'Q4_K_M',
    sizeGB: 4.7,
    ramGB: 9,
    note: 'Sabse samajhdaar — 16 GB RAM chahiye. CPU par slow (2-5 tok/s).',
    recommendedFor: 16,
    url: `${HF}/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf?download=true`,
    filename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf'
  },
  {
    id: 'llama-3.2-3b',
    name: 'Llama 3.2 3B Instruct',
    params: '3B',
    quant: 'Q4_K_M',
    sizeGB: 2.0,
    ramGB: 5,
    note: 'General purpose — English/Hinglish samajhna better, code thoda kam.',
    recommendedFor: 8,
    url: `${HF}/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf?download=true`,
    filename: 'llama-3.2-3b-instruct-q4_k_m.gguf'
  },
  {
    id: 'qwen2.5-coder-0.5b',
    name: 'Qwen2.5 Coder 0.5B',
    params: '0.5B',
    quant: 'Q4_K_M',
    sizeGB: 0.4,
    ramGB: 1.5,
    note: 'Sirf test ke liye — autocomplete/snippets. Bade kaam ke liye 1.5B lo.',
    recommendedFor: 2,
    url: `${HF}/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf?download=true`,
    filename: 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf'
  }
];

const downloads = new Map(); // id -> progress

const modelPath = (m) => path.join(cfg.MODELS_DIR, m.file);
const recommendFor = () => {
  const ram = hostMemMb();
  if (ram < 2500) return CATALOG.find((c) => c.id === 'qwen2.5-coder-0.5b');
  if (ram < 5000) return CATALOG[0];
  if (ram < 9000) return CATALOG[1];
  return CATALOG[2];
};

/**
 * Disk par jo model pada hai usme se best chuno (RAM me fit hone wala sabse bada).
 * Fresh install ke baad panel khud isse load kar leta hai.
 */
function pickInstalled() {
  const st = store.get();
  const ram = hostMemMb();
  const all = (st.models || [])
    .map((m) => {
      let size = 0;
      try {
        size = fs.statSync(modelPath(m)).size;
      } catch {}
      return { ...m, size, exists: size > 0 };
    })
    .filter((m) => m.exists);
  if (!all.length) return null;
  const fits = all.filter((m) => Math.ceil((m.size * 1.15) / 1048576) + 512 <= ram);
  const pool = fits.length ? fits : all;
  pool.sort((a, b) => b.size - a.size);
  return pool[0];
}

function list() {
  const st = store.get();
  const ram = hostMemMb();
  const installed = (st.models || []).map((m) => {
    const p = modelPath(m);
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {}
    return {
      ...m,
      size,
      sizeText: fmtBytes(size),
      exists: size > 0,
      loaded: st.settings.modelId === m.id,
      download: downloads.get(m.id) || null
    };
  });
  const have = new Set(installed.map((m) => m.id));
  const catalog = CATALOG.map((c) => ({
    ...c,
    sizeText: `~${c.sizeGB} GB`,
    installed: have.has(c.id),
    fits: ram >= c.ramGB * 1024,
    download: downloads.get(c.id) || null
  }));
  const rec = recommendFor();
  return { installed, catalog, recommend: rec ? rec.id : null, hostRamMB: ram };
}

async function refreshFromDisk() {
  await ensureDir(cfg.MODELS_DIR);
  const st = store.get();
  const files = (await fsp.readdir(cfg.MODELS_DIR).catch(() => [])).filter((f) => f.toLowerCase().endsWith('.gguf'));
  let added = 0;
  for (const f of files) {
    if ((st.models || []).some((m) => m.file === f)) continue;
    const size = await fileSize(path.join(cfg.MODELS_DIR, f));
    const id = `local-${f.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
    await store.update((s) => {
      s.models.push({ id, name: f.replace(/\.gguf$/i, ''), file: f, size, local: true, addedAt: Date.now() });
    });
    added++;
  }
  return added;
}

async function download(idOrUrl, { url, name } = {}) {
  const st = store.get();
  const cat = CATALOG.find((c) => c.id === idOrUrl);
  const src = url || (cat && cat.url);
  if (!src) throw Object.assign(new Error('URL nahi mila'), { status: 400 });
  if (!/^https?:\/\//i.test(src)) throw Object.assign(new Error('Sirf http(s) URL'), { status: 400 });

  const id = cat
    ? cat.id
    : `custom-${String(name || path.basename(new URL(src).pathname) || 'model')
        .replace(/\.gguf$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .slice(0, 40)}`;

  if (downloads.has(id)) throw Object.assign(new Error('Download pehle se chal raha hai'), { status: 409 });
  if ((st.models || []).some((m) => m.id === id) && !cat) {
    throw Object.assign(new Error('Is naam ka model pehle se hai'), { status: 409 });
  }

  const filename = cat ? cat.filename : `${id}.gguf`;
  const dest = path.join(cfg.MODELS_DIR, filename);
  const part = `${dest}.part`;
  await ensureDir(cfg.MODELS_DIR);

  const progress = { id, received: 0, total: 0, startedAt: Date.now(), done: false, error: null, url: src, name: cat ? cat.name : name || id };
  downloads.set(id, progress);

  (async () => {
    try {
      const res = await fetch(src, { redirect: 'follow', headers: { 'User-Agent': 'forge/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} — URL ya network check karein`);
      progress.total = Number(res.headers.get('content-length') || 0);
      let received = 0;
      const counter = new Transform({
        transform(chunk, enc, cb) {
          received += chunk.length;
          progress.received = received;
          cb(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
      const real = await fileSize(part);
      if (real < 1024 * 1024) throw new Error('File bahut chhoti hai — galat URL lagta hai');
      await fsp.rm(dest, { force: true }).catch(() => {});
      await fsp.rename(part, dest);
      progress.done = true;
      progress.received = real;
      await store.update((s) => {
        s.models = (s.models || []).filter((m) => m.id !== id);
        s.models.push({
          id,
          name: cat ? cat.name : name || id,
          file: filename,
          size: real,
          params: cat ? cat.params : '',
          quant: cat ? cat.quant : '',
          url: src,
          addedAt: Date.now()
        });
      });
    } catch (e) {
      progress.error = e.message;
      await fsp.rm(part, { force: true }).catch(() => {});
    } finally {
      setTimeout(() => downloads.delete(id), 60000);
    }
  })();

  return progress;
}

async function remove(id) {
  const st = store.get();
  const model = (st.models || []).find((m) => m.id === id);
  if (!model) throw Object.assign(new Error('Model nahi mila'), { status: 404 });
  if (st.settings.modelId === id) {
    throw Object.assign(new Error('Ye model load hai — pehle unload karein'), { status: 409 });
  }
  await fsp.rm(modelPath(model), { force: true }).catch(() => {});
  await store.update((s) => {
    s.models = s.models.filter((m) => m.id !== id);
  });
  return { ok: true };
}

function get(id) {
  const st = store.get();
  return (st.models || []).find((m) => m.id === id) || null;
}

module.exports = { CATALOG, list, pickInstalled, download, remove, get, modelPath, refreshFromDisk, downloads, recommendFor };
