'use strict';
/**
 * VPSDeck config — saara path/limit yahin se aata hai.
 * Env vars se override kar sakte hain (installer inhe set karta hai).
 */
const path = require('path');

const APP_DIR = path.resolve(process.env.APP_DIR || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, 'data'));

const cleanPort = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : def;
};

module.exports = {
  APP_DIR,
  DATA_DIR,
  VMS_DIR: path.join(DATA_DIR, 'vms'),
  IMAGES_DIR: path.join(DATA_DIR, 'images'),
  SEEDS_DIR: path.join(DATA_DIR, 'seeds'),
  LOG_DIR: path.join(DATA_DIR, 'logs'),
  PANEL_JSON: path.join(DATA_DIR, 'panel.json'),

  HOST: process.env.HOST || '0.0.0.0',
  PORT: cleanPort(process.env.PORT, 8080),

  // Session / auth
  SESSION_TTL: 7 * 24 * 60 * 60 * 1000,
  LOGIN_WINDOW: 5 * 60 * 1000,
  LOGIN_MAX_TRIES: 10,

  // SSH forward ports (host -> guest 22), sirf localhost pe bind hote hain
  SSH_PORT_BASE: cleanPort(process.env.SSH_PORT_BASE, 22000),
  SSH_PORT_MAX: cleanPort(process.env.SSH_PORT_MAX, 22999),

  // VM defaults
  DEFAULT_CPU: 2,
  DEFAULT_MEM_MB: 1024,
  DEFAULT_DISK_GB: 10,
  MAX_CPU: 8,
  MAX_MEM_MB: 32768,
  MAX_DISK_GB: 500,
  MAX_VMS: 200,

  // Limits
  MAX_JSON_BODY: 2 * 1024 * 1024,
  MAX_ISO_BYTES: 16 * 1024 * 1024 * 1024,
  SERIAL_BUFFER_BYTES: 128 * 1024,
  MAX_IMAGE_DOWNLOAD_BYTES: 12 * 1024 * 1024 * 1024,

  QEMU_BIN: process.env.QEMU_BIN || 'qemu-system-x86_64',
  QEMU_IMG: process.env.QEMU_IMG || 'qemu-img',
  QEMU_MACHINE: process.env.QEMU_MACHINE || 'q35',

  STOP_TIMEOUT_MS: 25000,
  BOOT_GRACE_MS: 1200
};
