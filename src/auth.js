'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { HttpError } = require('./util');

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;

class Auth {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.sessions = new Map(); // token -> expiresAt
    this.attempts = new Map(); // ip -> { count, resetAt }

    setInterval(() => this._sweep(), 10 * 60 * 1000).unref?.();
  }

  get needsSetup() {
    return !this.store.settings.passwordHash;
  }

  async _hash(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, KEY_LEN);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
  }

  async _compare(password, stored) {
    if (!stored) return false;
    const [scheme, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const derived = await scrypt(password, salt, expected.length);
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }

  static validatePassword(password) {
    if (typeof password !== 'string') throw new HttpError(400, 'Password is required');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (password.length > 200) throw new HttpError(400, 'Password is too long');
  }

  async setup(password) {
    if (!this.needsSetup) throw new HttpError(409, 'Panel is already configured');
    Auth.validatePassword(password);
    this.store.settings.passwordHash = await this._hash(password);
    this.store.settings.installedAt = Date.now();
    await this.store.save(true);
    return this.createSession();
  }

  async login(password, ip) {
    this._checkAttempts(ip);
    if (!password || typeof password !== 'string') throw new HttpError(400, 'Password is required');
    if (this.needsSetup) throw new HttpError(409, 'Panel is not configured yet');

    const ok = await this._compare(password, this.store.settings.passwordHash);
    if (!ok) {
      this._recordFailure(ip);
      throw new HttpError(401, 'Wrong password');
    }
    this.attempts.delete(ip);
    this.store.settings.lastLoginAt = Date.now();
    this.store.save();
    return this.createSession();
  }

  async changePassword(current, next) {
    Auth.validatePassword(next);
    const ok = await this._compare(current || '', this.store.settings.passwordHash);
    if (!ok) throw new HttpError(401, 'Current password is incorrect');
    this.store.settings.passwordHash = await this._hash(next);
    await this.store.save(true);
    this.sessions.clear(); // force re-login everywhere
    return this.createSession();
  }

  createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + this.cfg.SESSION_TTL);
    return token;
  }

  checkToken(token) {
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    // sliding expiry
    this.sessions.set(token, Date.now() + this.cfg.SESSION_TTL);
    return true;
  }

  destroy(token) {
    if (token) this.sessions.delete(token);
  }

  _checkAttempts(ip) {
    const entry = this.attempts.get(ip);
    if (!entry) return;
    if (entry.resetAt < Date.now()) {
      this.attempts.delete(ip);
      return;
    }
    if (entry.count >= 10) {
      const wait = Math.ceil((entry.resetAt - Date.now()) / 1000);
      throw new HttpError(429, `Too many failed attempts. Try again in ${wait}s`);
    }
  }

  _recordFailure(ip) {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt < now) {
      this.attempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
    } else {
      entry.count += 1;
    }
  }

  _sweep() {
    const now = Date.now();
    for (const [token, expires] of this.sessions) if (expires < now) this.sessions.delete(token);
    for (const [ip, entry] of this.attempts) if (entry.resetAt < now) this.attempts.delete(ip);
  }
}

module.exports = Auth;
