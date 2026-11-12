'use strict';
/** Forge config — sab kuch env se override ho sakta hai. */
const path = require('path');

const APP_DIR = path.resolve(process.env.APP_DIR || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, 'data'));

const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

module.exports = {
  APP_DIR,
  DATA_DIR,
  MODELS_DIR: path.join(DATA_DIR, 'models'),
  WORKSPACE_DIR: process.env.WORKSPACE_DIR
    ? path.resolve(process.env.WORKSPACE_DIR)
    : path.join(DATA_DIR, 'workspace'),
  CHATS_DIR: path.join(DATA_DIR, 'chats'),
  BIN_DIR: path.join(DATA_DIR, 'bin'),
  PANEL_JSON: path.join(DATA_DIR, 'panel.json'),

  HOST: process.env.HOST || '0.0.0.0',
  PORT: int(process.env.PORT, 4040),

  // Andar chalne wala llama-server
  LLM_PORT: int(process.env.LLM_PORT, 4055),
  LLM_HOST: '127.0.0.1',
  // Agar pehle se koi OpenAI-compatible server chal raha hai (llama.cpp / Ollama / vLLM)
  LLM_URL: process.env.LLM_URL || '',

  // Model defaults
  CTX_SIZE: int(process.env.CTX_SIZE, 4096),
  THREADS: int(process.env.THREADS, Math.max(2, Math.min(6, require('os').cpus().length))),
  DEFAULT_MAX_TOKENS: int(process.env.MAX_TOKENS, 1600),
  TEMPERATURE: Number(process.env.TEMPERATURE || 0.2),

  SESSION_TTL: 7 * 24 * 60 * 60 * 1000,
  LOGIN_WINDOW: 5 * 60 * 1000,
  LOGIN_MAX_TRIES: 12,

  MAX_JSON_BODY: 4 * 1024 * 1024,
  MAX_FILE_BYTES: 512 * 1024,
  MAX_CONTEXT_FILES: 12,
  MAX_UPLOAD_BYTES: 200 * 1024 * 1024,

  LLM_START_TIMEOUT: int(process.env.LLM_START_TIMEOUT, 180000),
  NO_AUTH: process.env.NO_AUTH === '1'
};
