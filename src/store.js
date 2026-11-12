'use strict';
/**
 * State: data/panel.json (settings + chat index + installed models)
 *        data/chats/<id>.json (messages)
 */
const fsp = require('fs').promises;
const path = require('path');
const cfg = require('./config');
const { readJson, writeJsonAtomic, ensureDir, uid } = require('./util');

const EMPTY = () => ({
  version: 1,
  createdAt: Date.now(),
  auth: null,
  settings: {
    modelId: null,
    temperature: 0.2,
    maxTokens: 1600,
    ctxSize: 4096,
    preset: 'engineer',
    useProjectContext: true,
    autoApply: false,
    theme: 'dark'
  },
  chats: [],
  models: []
});

let state = null;
let queue = Promise.resolve();
let dirty = false;

async function init() {
  await ensureDir(cfg.DATA_DIR);
  await ensureDir(cfg.CHATS_DIR);
  state = Object.assign(EMPTY(), await readJson(cfg.PANEL_JSON, {}));
  state.settings = Object.assign(EMPTY().settings, state.settings || {});
  if (!Array.isArray(state.chats)) state.chats = [];
  if (!Array.isArray(state.models)) state.models = [];
  return state;
}

const get = () => {
  if (!state) throw new Error('store not ready');
  return state;
};

function save() {
  dirty = true;
  queue = queue.then(async () => {
    if (!dirty) return;
    dirty = false;
    await writeJsonAtomic(cfg.PANEL_JSON, state);
  });
  return queue.catch((e) => console.error('[store]', e.message));
}

async function update(fn) {
  const r = fn(get());
  await save();
  return r;
}

// ------------------------------------------------------------------ chats
const chatPath = (id) => path.join(cfg.CHATS_DIR, `${id}.json`);

async function createChat({ title = 'Naya chat', preset } = {}) {
  const chat = {
    id: `c-${uid(10)}`,
    title,
    preset: preset || get().settings.preset,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  };
  await writeJsonAtomic(chatPath(chat.id), chat);
  await update((s) => {
    s.chats.unshift({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, count: 0 });
  });
  return chat;
}

async function getChat(id) {
  const chat = await readJson(chatPath(id), null);
  if (!chat) return null;
  return chat;
}

async function saveChat(chat) {
  chat.updatedAt = Date.now();
  await writeJsonAtomic(chatPath(chat.id), chat);
  await update((s) => {
    const item = s.chats.find((c) => c.id === chat.id);
    if (item) {
      item.title = chat.title;
      item.updatedAt = chat.updatedAt;
      item.count = chat.messages.length;
    } else {
      s.chats.unshift({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, count: chat.messages.length });
    }
  });
  return chat;
}

async function deleteChat(id) {
  await fsp.rm(chatPath(id), { force: true }).catch(() => {});
  await update((s) => {
    s.chats = s.chats.filter((c) => c.id !== id);
  });
}

function listChats() {
  return get()
    .chats.slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

module.exports = { init, get, save, update, createChat, getChat, saveChat, deleteChat, listChats, chatPath };
