'use strict';
/**
 * Workspace = aapka project folder (data/workspace by default).
 * File tree, read/write, multi-file apply, zip export, live HTML preview.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cfg = require('./config');
const { safeJoin, ensureDir, zipFiles, fileSize } = require('./util');

const IGNORE = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '__pycache__', '.next', '.venv']);
const MAX_PREVIEW_FILE = 400 * 1024;

const root = () => cfg.WORKSPACE_DIR;

async function init() {
  await ensureDir(root());
}

async function walk(dir, base = '', depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ type: 'dir', path: rel, name: e.name });
      await walk(path.join(dir, e.name), rel, depth + 1, out);
    } else {
      let size = 0;
      try {
        size = (await fsp.stat(path.join(dir, e.name))).size;
      } catch {}
      out.push({ type: 'file', path: rel, name: e.name, size, ext: path.extname(e.name).slice(1).toLowerCase() });
    }
  }
  return out;
}

const tree = () => walk(root());

async function read(rel) {
  const abs = safeJoin(root(), rel);
  if (!abs) throw Object.assign(new Error('Galat path'), { status: 400 });
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw Object.assign(new Error('File nahi mili'), { status: 404 });
  if (st.size > cfg.MAX_FILE_BYTES) throw Object.assign(new Error('File bahut badi hai'), { status: 413 });
  return { path: rel, content: await fsp.readFile(abs, 'utf8'), size: st.size };
}

async function write(rel, content) {
  const abs = safeJoin(root(), rel);
  if (!abs) throw Object.assign(new Error('Galat path'), { status: 400 });
  if (String(content).length > cfg.MAX_FILE_BYTES) {
    throw Object.assign(new Error('File bahut badi hai (512 KB limit)'), { status: 413 });
  }
  await ensureDir(path.dirname(abs));
  await fsp.writeFile(abs, content, 'utf8');
  return { ok: true, path: rel, size: Buffer.byteLength(content) };
}

async function remove(rel) {
  const abs = safeJoin(root(), rel);
  if (!abs || abs === path.resolve(root())) throw Object.assign(new Error('Galat path'), { status: 400 });
  await fsp.rm(abs, { recursive: true, force: true });
  return { ok: true };
}

/** model ke diye hue files ek saath likho */
async function applyFiles(files = []) {
  const written = [];
  for (const f of files.slice(0, 40)) {
    const p = String(f.path || '').trim();
    if (!p) continue;
    await write(p, String(f.content == null ? '' : f.content));
    written.push(p);
  }
  return { ok: true, files: written };
}

async function zip({ only = null } = {}) {
  const entries = await walk(root());
  const files = [];
  let total = 0;
  for (const e of entries) {
    if (e.type !== 'file') continue;
    if (only && !only.includes(e.path)) continue;
    const abs = safeJoin(root(), e.path);
    if (!abs) continue;
    const data = await fsp.readFile(abs).catch(() => null);
    if (!data) continue;
    total += data.length;
    if (total > 60 * 1024 * 1024) break;
    files.push({ name: e.path, data });
  }
  return zipFiles(files);
}

/** index.html me local css/js inline karke preview banao */
async function previewHtml(entryRel) {
  const entries = await walk(root());
  const htmls = entries.filter((e) => e.type === 'file' && /\.html?$/i.test(e.path));
  const entry = entryRel
    ? entries.find((e) => e.path === entryRel)
    : htmls.find((e) => /^index\.html?$/i.test(e.path)) || htmls[0];
  if (!entry) {
    return {
      html: null,
      message: 'Workspace me koi .html file nahi hai. AI se ek webpage banwao, phir yahan preview dikhega.'
    };
  }
  const abs = safeJoin(root(), entry.path);
  let html = await fsp.readFile(abs, 'utf8');
  if (html.length > MAX_PREVIEW_FILE) html = html.slice(0, MAX_PREVIEW_FILE);
  const dir = path.posix.dirname(entry.path);
  const resolveRel = (href) => {
    const clean = href.replace(/^\.\//, '').replace(/^\//, '').split('?')[0].split('#')[0];
    return dir === '.' ? clean : path.posix.normalize(`${dir}/${clean}`);
  };

  // <link rel=stylesheet href=...>
  const cssRe = /<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi;
  html = await replaceAsync(html, cssRe, async (tag) => {
    const m = /href=["']([^"']+)["']/i.exec(tag);
    if (!m || /^https?:|^\/\//.test(m[1])) return tag;
    const file = await read(resolveRel(m[1])).catch(() => null);
    return file ? `<style>\n${file.content}\n</style>` : tag;
  });

  // <script src=...></script>
  const jsRe = /<script[^>]+src=["']([^"']+)["'][^>]*>\s*<\/script>/gi;
  html = await replaceAsync(html, jsRe, async (tag) => {
    const m = /src=["']([^"']+)["']/i.exec(tag);
    if (!m || /^https?:|^\/\//.test(m[1])) return tag;
    const file = await read(resolveRel(m[1])).catch(() => null);
    return file ? `<script>\n${file.content}\n</script>` : tag;
  });

  // <img src="local.png"> -> data URI (chhoti images)
  return { html, entry: entry.path, files: entries.filter((e) => e.type === 'file').length };
}

async function replaceAsync(str, re, fn) {
  const jobs = [];
  str.replace(re, (...args) => {
    jobs.push(fn(args[0]));
    return args[0];
  });
  const done = await Promise.all(jobs);
  let i = 0;
  return str.replace(re, () => done[i++]);
}

async function stats() {
  const entries = await walk(root());
  const files = entries.filter((e) => e.type === 'file');
  let size = 0;
  for (const f of files) size += f.size || 0;
  return { files: files.length, dirs: entries.length - files.length, size };
}

/** model ke context ke liye project files padho (chhoti list) */
async function contextFiles(limit = cfg.MAX_CONTEXT_FILES) {
  const entries = await walk(root());
  const files = entries.filter((e) => e.type === 'file').slice(0, limit);
  const out = [];
  let budget = 24000; // characters
  for (const f of files) {
    if (f.size > 60000) continue;
    const r = await read(f.path).catch(() => null);
    if (!r) continue;
    const content = r.content.slice(0, Math.max(0, budget));
    if (!content) break;
    budget -= content.length;
    out.push({ path: f.path, content });
    if (budget <= 0) break;
  }
  return out;
}

module.exports = { init, root, tree, read, write, remove, applyFiles, zip, previewHtml, stats, contextFiles };
