'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Everything is configurable with environment variables so the panel can be
 * moved / renamed without touching code.
 */
module.exports = {
  ROOT,
  HOST: process.env.HOST || '0.0.0.0',
  PORT: Number(process.env.PORT) || 3000,

  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, 'data'),
  BOTS_DIR: process.env.BOTS_DIR || path.join(ROOT, 'bots'),
  LOGS_DIR: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'logs'),

  STORE_FILE: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'panel.json'),

  SESSION_TTL: 7 * 24 * 60 * 60 * 1000, // 7 days
  LOG_MAX_BYTES: 4 * 1024 * 1024, // rotate bot log at 4 MB
  MAX_LOG_LINES: 600, // in-memory console buffer per bot
  MAX_JSON_BODY: 10 * 1024 * 1024,
  MAX_UPLOAD_BYTES: 256 * 1024 * 1024,
  MAX_EDIT_BYTES: 8 * 1024 * 1024,
  RESTART_BASE_DELAY: 1000,
  RESTART_MAX_DELAY: 15000,
  STOP_TIMEOUT: 8000,
  MEMORY_CHECK_INTERVAL: 5000
};
