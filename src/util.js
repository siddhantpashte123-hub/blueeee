'use strict';

const crypto = require('crypto');
const path = require('path');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function uid(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(8).toString('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * Join a user supplied relative path to a root directory, refusing anything
 * that would escape the sandbox folder (../../etc/passwd etc).
 */
function safeJoin(root, relPath) {
  const raw = String(relPath == null ? '' : relPath);
  if (raw.includes('\0')) throw new HttpError(400, 'Invalid path');
  const decoded = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, decoded);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new HttpError(400, 'Path escapes the bot folder');
  }
  return target;
}

function relativeTo(root, absolute) {
  const rel = path.relative(path.resolve(root), path.resolve(absolute));
  return rel.split(path.sep).join('/');
}

/** Tiny POSIX-ish argument splitter (supports "quoted strings"). */
function shellSplit(input) {
  const out = [];
  let current = '';
  let quote = null;
  let pending = false;
  const src = String(input || '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && src[i + 1] !== undefined) current += src[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      pending = true;
    } else if (/\s/.test(ch)) {
      if (current || pending) {
        out.push(current);
        current = '';
        pending = false;
      }
    } else if (ch === '\\' && src[i + 1] !== undefined) {
      current += src[++i];
      pending = true;
    } else {
      current += ch;
      pending = true;
    }
  }
  if (current || pending) out.push(current);
  return out;
}

function isPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function cleanString(value, max = 500) {
  if (value == null) return '';
  return String(value).replace(/\0/g, '').slice(0, max);
}

module.exports = {
  HttpError,
  uid,
  sleep,
  formatBytes,
  safeJoin,
  relativeTo,
  shellSplit,
  isPort,
  cleanString
};
