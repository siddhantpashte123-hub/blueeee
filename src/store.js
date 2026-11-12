'use strict';
/**
 * Panel state — data/panel.json
 * Saare write ek queue se hote hain, isliye parallel requests se file corrupt nahi hoti.
 */
const fs = require('fs');
const { PANEL_JSON, DATA_DIR } = require('./config');
const { readJson, writeJsonAtomic, ensureDir } = require('./util');

const EMPTY = () => ({
  version: 1,
  createdAt: Date.now(),
  auth: null,
  vms: [],
  images: [],
  settings: {}
});

let state = null;
let queue = Promise.resolve();
let dirty = false;

async function init() {
  await ensureDir(DATA_DIR);
  state = Object.assign(EMPTY(), await readJson(PANEL_JSON, {}));
  if (!Array.isArray(state.vms)) state.vms = [];
  if (!Array.isArray(state.images)) state.images = [];
  if (!state.settings) state.settings = {};
  return state;
}

function get() {
  if (!state) throw new Error('store not initialised');
  return state;
}

/** Serialized save — ek ke baad ek. */
function save() {
  queue = queue.then(async () => {
    if (!dirty) return;
    dirty = false;
    await writeJsonAtomic(PANEL_JSON, state);
  });
  return queue.catch((e) => {
    console.error('[store] save failed:', e.message);
  });
}

/** Mutate + save shortcut. */
async function update(fn) {
  const r = fn(get());
  dirty = true;
  await save();
  return r;
}

/** File me bhi turant likhna ho to (shutdown ke waqt) */
async function flush() {
  dirty = true;
  await save();
}

function lastWriteOk() {
  try {
    fs.accessSync(PANEL_JSON, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { init, get, save, update, flush, lastWriteOk };
