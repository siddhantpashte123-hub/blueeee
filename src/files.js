'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { HttpError, safeJoin, relativeTo } = require('./util');

const execFileAsync = promisify(execFile);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.tar', '.mp3', '.mp4', '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.so',
  '.node', '.dylib', '.dll', '.pyc', '.class', '.jar', '.db', '.sqlite', '.7z', '.rar'
]);

function looksBinary(buffer, filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (BINARY_EXT.has(ext)) return true;
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096));
  return probe.includes(0);
}

async function listDir(root, relPath) {
  const dir = safeJoin(root, relPath);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, 'Folder not found');
    if (err.code === 'ENOTDIR') throw new HttpError(400, 'Not a folder');
    throw err;
  }

  const items = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      let stat = null;
      try {
        stat = await fsp.lstat(full);
      } catch (_) {
        /* vanished */
      }
      const isSymlink = entry.isSymbolicLink();
      const isDir = entry.isDirectory();
      return {
        name: entry.name,
        type: isDir ? 'dir' : isSymlink ? 'symlink' : 'file',
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtimeMs : 0,
        path: relativeTo(root, full)
      };
    })
  );

  items.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (b.type === 'dir' && a.type !== 'dir') return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  return { path: relativeTo(root, dir), items };
}

async function readFile(root, relPath, maxBytes) {
  const file = safeJoin(root, relPath);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw new HttpError(404, 'File not found');
  if (stat.isDirectory()) throw new HttpError(400, 'This is a folder');
  if (stat.size > maxBytes) throw new HttpError(413, `File is too large to edit (${stat.size} bytes)`);

  const buffer = await fsp.readFile(file);
  if (looksBinary(buffer, file)) throw new HttpError(415, 'Binary file — download it instead');
  return { path: relativeTo(root, file), content: buffer.toString('utf8'), size: stat.size, mtime: stat.mtimeMs };
}

async function writeFile(root, relPath, content) {
  const file = safeJoin(root, relPath);
  if (!String(relPath).trim()) throw new HttpError(400, 'File path is required');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const stat = await fsp.stat(file).catch(() => null);
  if (stat && stat.isDirectory()) throw new HttpError(400, 'Cannot write to a folder');
  await fsp.writeFile(file, content);
  return { ok: true, path: relativeTo(root, file), size: Buffer.byteLength(content) };
}

async function saveUpload(root, relDir, filename, stream, maxBytes) {
  const cleanName = path.basename(String(filename || '').replace(/\\/g, '/'));
  if (!cleanName || cleanName === '.' || cleanName === '..' || cleanName.includes('\0')) {
    throw new HttpError(400, 'Invalid file name');
  }
  const dir = safeJoin(root, relDir);
  await fsp.mkdir(dir, { recursive: true });
  const dest = safeJoin(dir, cleanName);

  let received = 0;
  const sink = fs.createWriteStream(dest);
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new HttpError(413, 'Upload is too large'));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(stream, guard, sink);
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `Upload failed: ${err.message}`);
  }
  return { ok: true, path: relativeTo(root, dest), size: received };
}

async function mkdir(root, relPath) {
  if (!String(relPath).trim()) throw new HttpError(400, 'Folder name is required');
  const dir = safeJoin(root, relPath);
  await fsp.mkdir(dir, { recursive: true });
  return { ok: true, path: relativeTo(root, dir) };
}

async function rename(root, from, to) {
  if (!String(from).trim() || !String(to).trim()) throw new HttpError(400, 'Both paths are required');
  const source = safeJoin(root, from);
  const dest = safeJoin(root, to);
  if (source === path.resolve(root)) throw new HttpError(400, 'Cannot rename the bot root');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(source, dest);
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, 'Path not found');
    if (err.code === 'EEXIST') throw new HttpError(409, 'A file with that name already exists');
    throw err;
  }
  return { ok: true, path: relativeTo(root, dest) };
}

async function remove(root, relPath) {
  if (!String(relPath).trim()) throw new HttpError(400, 'Path is required');
  const target = safeJoin(root, relPath);
  if (target === path.resolve(root)) throw new HttpError(400, 'Cannot delete the bot folder');
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true };
}

async function extract(root, relPath) {
  const file = safeJoin(root, relPath);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw new HttpError(404, 'Archive not found');
  const dir = path.dirname(file);
  const lower = file.toLowerCase();

  try {
    if (lower.endsWith('.zip')) {
      try {
        await execFileAsync('unzip', ['-o', '-q', file, '-d', dir], { timeout: 120000 });
      } catch (err) {
        if (err.code === 'ENOENT') {
          // no unzip binary — use python's zipfile with zip-slip protection
          const script = [
            'import os, shutil, sys, zipfile',
            'base = os.path.realpath(sys.argv[2])',
            'z = zipfile.ZipFile(sys.argv[1])',
            'for m in z.infolist():',
            '    dest = os.path.realpath(os.path.join(base, m.filename))',
            '    if dest != base and not dest.startswith(base + os.sep): continue',
            '    if m.is_dir():',
            '        os.makedirs(dest, exist_ok=True); continue',
            '    os.makedirs(os.path.dirname(dest), exist_ok=True)',
            '    with z.open(m) as src, open(dest, "wb") as out: shutil.copyfileobj(src, out)'
          ].join('\n');
          await execFileAsync('python3', ['-c', script, file, dir], { timeout: 120000 });
        } else {
          throw err;
        }
      }
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      await execFileAsync('tar', ['-xzf', file, '-C', dir], { timeout: 120000 });
    } else if (lower.endsWith('.tar')) {
      await execFileAsync('tar', ['-xf', file, '-C', dir], { timeout: 120000 });
    } else {
      throw new HttpError(400, 'Supported archives: .zip, .tar, .tar.gz, .tgz');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `Extraction failed: ${err.message}`);
  }

  const after = await fsp.readdir(dir);
  return { ok: true, files: after.length };
}

module.exports = { listDir, readFile, writeFile, saveUpload, mkdir, rename, remove, extract, looksBinary };
