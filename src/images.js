'use strict';
/**
 * Base images: Ubuntu/Debian/Alpine cloud images download + custom ISO upload.
 * Har VM ek qcow2 overlay banata hai (base image chhoti rehti hai, disk space bachta hai).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const cfg = require('./config');
const store = require('./store');
const { run, runOk, ensureDir, fileSize, exists, fmtBytes } = require('./util');

/** Built-in catalog — sab official cloud images */
const CATALOG = [
  {
    id: 'ubuntu-24.04',
    name: 'Ubuntu 24.04 LTS',
    kind: 'cloud',
    user: 'ubuntu',
    url: 'https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img',
    approxMB: 300,
    note: 'Minimal cloud image — cloud-init supported'
  },
  {
    id: 'ubuntu-22.04',
    name: 'Ubuntu 22.04 LTS',
    kind: 'cloud',
    user: 'ubuntu',
    url: 'https://cloud-images.ubuntu.com/minimal/releases/jammy/release/ubuntu-22.04-minimal-cloudimg-amd64.img',
    approxMB: 280,
    note: 'Sabse tested cloud image'
  },
  {
    id: 'debian-12',
    name: 'Debian 12 (bookworm)',
    kind: 'cloud',
    user: 'debian',
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2',
    approxMB: 350,
    note: 'Generic cloud image — cloud-init supported'
  },
  {
    id: 'alpine-3.21',
    name: 'Alpine Linux 3.21',
    kind: 'cloud',
    user: 'alpine',
    url: 'https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/cloud/nocloud_alpine-3.21.3-x86_64-bios-cloudinit-r0.qcow2',
    approxMB: 60,
    note: 'Bahut halka — purane/slow VPS ke liye best'
  }
];

const downloads = new Map(); // id -> progress

function imagePath(img) {
  return path.join(cfg.IMAGES_DIR, img.file);
}

function list() {
  const st = store.get();
  const images = (st.images || []).map((img) => {
    const p = imagePath(img);
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {}
    return {
      ...img,
      size,
      sizeText: fmtBytes(size),
      exists: size > 0,
      download: downloads.get(img.id) || null
    };
  });
  const have = new Set(images.map((i) => i.id));
  const catalog = CATALOG.map((c) => ({
    ...c,
    installed: have.has(c.id),
    download: downloads.get(c.id) || null,
    sizeText: `~${c.approxMB} MB`
  }));
  return { images, catalog };
}

async function download(idOrCatalogId, { url, name, user } = {}) {
  const st = store.get();
  let img = (st.images || []).find((i) => i.id === idOrCatalogId);
  const cat = CATALOG.find((c) => c.id === idOrCatalogId);

  const src = url || (cat && cat.url);
  if (!src) throw Object.assign(new Error('URL nahi mila'), { status: 400 });
  if (!/^https?:\/\//i.test(src)) throw Object.assign(new Error('Sirf http(s) URL allowed'), { status: 400 });

  if (!img) {
    const ext = (path.extname(new URL(src).pathname) || '.img').toLowerCase().slice(0, 8);
    img = {
      id: idOrCatalogId,
      name: name || (cat ? cat.name : idOrCatalogId),
      kind: 'cloud',
      user: user || (cat ? cat.user : 'ubuntu'),
      url: src,
      file: `${idOrCatalogId.replace(/[^a-z0-9._-]/gi, '_')}${ext}`,
      addedAt: Date.now()
    };
    await store.update((s) => {
      s.images = (s.images || []).filter((i) => i.id !== img.id);
      s.images.push(img);
    });
  }

  if (downloads.has(img.id)) throw Object.assign(new Error('Download pehle se chal raha hai'), { status: 409 });

  const dest = imagePath(img);
  await ensureDir(cfg.IMAGES_DIR);
  const part = `${dest}.part`;
  const progress = { id: img.id, received: 0, total: 0, startedAt: Date.now(), done: false, error: null, url: src };
  downloads.set(img.id, progress);

  (async () => {
    try {
      const res = await fetch(src, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      progress.total = Number(res.headers.get('content-length') || 0);
      const out = fs.createWriteStream(part);
      let received = 0;
      const counter = new Transform({
        transform(chunk, enc, cb) {
          received += chunk.length;
          progress.received = received;
          if (received > cfg.MAX_IMAGE_DOWNLOAD_BYTES) {
            return cb(new Error('Image bahut badi hai (limit cross)'));
          }
          cb(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(res.body), counter, out);
      const real = await fileSize(part);
      if (real < 1024 * 1024) throw new Error('File bahut chhoti hai — galat URL lagta hai');
      await fsp.rename(part, dest);
      progress.done = true;
      progress.received = real;
      progress.finishedAt = Date.now();
      await store.update((s) => {
        const it = s.images.find((i) => i.id === img.id);
        if (it) {
          it.size = real;
          it.downloadedAt = Date.now();
        }
      });
    } catch (e) {
      progress.error = e.message;
      await fsp.rm(part, { force: true }).catch(() => {});
    } finally {
      setTimeout(() => downloads.delete(img.id), 60000);
    }
  })();

  return progress;
}

async function remove(id) {
  const st = store.get();
  const used = (st.vms || []).filter((v) => v.imageId === id);
  if (used.length) {
    throw Object.assign(
      new Error(`Ye image ${used.length} VM use kar rahe hain. Pehle unhe delete karein.`),
      { status: 409 }
    );
  }
  const img = (st.images || []).find((i) => i.id === id);
  if (img) {
    await fsp.rm(imagePath(img), { force: true }).catch(() => {});
  }
  await store.update((s) => {
    s.images = s.images.filter((i) => i.id !== id);
  });
  return { ok: true };
}

/** Base image ka format (qcow2 / raw) */
async function imageFormat(img) {
  const e = await require('./qemu').env();
  if (!e.qemuImg) throw new Error('qemu-img install nahi hai');
  const r = await run(e.qemuImg, ['info', '--output=json', imagePath(img)], { timeout: 20000 });
  if (r.code !== 0) throw new Error(`Image padhi nahi ja saki: ${r.stderr.trim()}`);
  const j = JSON.parse(r.stdout);
  return { format: j.format || 'raw', virtualSize: j['virtual-size'] || 0 };
}

/** Upload (ISO ya qcow2) — body ko seedha file me stream karte hain */
async function saveUpload(name, stream, kind = 'iso') {
  const safe = String(name || 'upload.iso').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const id = `custom-${safe.replace(/\.[^.]+$/, '')}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 48);
  const ext = (path.extname(safe) || (kind === 'iso' ? '.iso' : '.img')).toLowerCase();
  const file = `${id}${ext}`;
  await ensureDir(cfg.IMAGES_DIR);
  const dest = path.join(cfg.IMAGES_DIR, file);
  const part = `${dest}.part`;
  let size = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length;
      if (size > cfg.MAX_ISO_BYTES) return cb(new Error('File bahut badi hai'));
      cb(null, chunk);
    }
  });
  await pipeline(stream, counter, fs.createWriteStream(part));
  if (size < 1024) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw Object.assign(new Error('Upload bahut chhoti file hai'), { status: 400 });
  }
  if (await exists(dest)) await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);

  const img = { id, name: safe, kind: ext === '.iso' ? 'iso' : 'disk', file, size, user: 'root', addedAt: Date.now(), uploaded: true };
  await store.update((s) => {
    s.images = (s.images || []).filter((i) => i.file !== file);
    s.images.push(img);
  });
  return img;
}

function getImage(id) {
  const st = store.get();
  return (st.images || []).find((i) => i.id === id) || null;
}

module.exports = { CATALOG, list, download, remove, getImage, imagePath, imageFormat, saveUpload, downloads };
