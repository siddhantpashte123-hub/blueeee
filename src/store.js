'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { uid } = require('./util');

/**
 * Tiny dependency-free JSON store with atomic writes.
 * Everything lives in one file: data/panel.json
 */
class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this._timer = null;
    this._writing = null;
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (raw) {
      try {
        this.data = JSON.parse(raw);
      } catch (err) {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.writeFileSync(backup, raw);
        } catch (_) {
          /* ignore */
        }
        console.error(`[store] panel.json is corrupt, backup saved to ${backup}. Starting fresh.`);
        this.data = null;
      }
    }

    if (!this.data || typeof this.data !== 'object') this.data = this._defaults();
    this.data.settings = Object.assign(this._defaultSettings(), this.data.settings || {});
    if (!Array.isArray(this.data.bots)) this.data.bots = [];
    this.save(true);
    return this;
  }

  _defaults() {
    return { version: 1, settings: this._defaultSettings(), bots: [] };
  }

  _defaultSettings() {
    return {
      panelName: 'BotDeck',
      passwordHash: null,
      sessionsVersion: uid('sv'),
      createdAt: Date.now(),
      installedAt: null,
      lastLoginAt: null
    };
  }

  get settings() {
    return this.data.settings;
  }

  save(immediate = false) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (immediate) return this._flush();
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush().catch((err) => console.error('[store] save failed:', err.message));
    }, 120);
    this._timer.unref?.();
    return Promise.resolve();
  }

  async _flush() {
    if (this._writing) await this._writing.catch(() => {});
    const payload = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.tmp-${process.pid}`;
    this._writing = (async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, this.file);
    })();
    try {
      await this._writing;
    } finally {
      this._writing = null;
    }
  }

  /* ---------------------------- bots ---------------------------------- */

  get bots() {
    return this.data.bots;
  }

  getBot(id) {
    return this.data.bots.find((b) => b.id === id) || null;
  }

  addBot(bot) {
    this.data.bots.push(bot);
    this.save();
    return bot;
  }

  updateBot(id, patch) {
    const bot = this.getBot(id);
    if (!bot) return null;
    Object.assign(bot, patch, { updatedAt: Date.now() });
    this.save();
    return bot;
  }

  removeBot(id) {
    const index = this.data.bots.findIndex((b) => b.id === id);
    if (index === -1) return false;
    this.data.bots.splice(index, 1);
    this.save();
    return true;
  }
}

module.exports = Store;
