'use strict';
/**
 * Serial console bridge.
 * QEMU serial port ko unix socket par kholta hai; panel us socket se judta hai
 * aur output browser tak (SSE) bhejta hai, input wapas likhta hai.
 * Isi wajah se VM ka console browser me chalta hai — koi VNC/noVNC nahi chahiye.
 */
const net = require('net');
const { EventEmitter } = require('events');
const { SERIAL_BUFFER_BYTES } = require('./config');

class SerialBridge extends EventEmitter {
  constructor(id, socketPath) {
    super();
    this.id = id;
    this.socketPath = socketPath;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.connecting = null;
    this.closedByUs = false;
    this.retries = 0;
  }

  get connected() {
    return !!(this.sock && !this.sock.destroyed);
  }

  /** socket se jodta hai; QEMU boot ho raha ho to retry karta hai */
  connect({ retries = 40, delay = 400 } = {}) {
    if (this.connected) return Promise.resolve(true);
    if (this.connecting) return this.connecting;
    this.closedByUs = false;
    this.connecting = new Promise((resolve) => {
      const tryOnce = (left) => {
        if (this.closedByUs) return resolve(false);
        const sock = net.createConnection(this.socketPath);
        const fail = () => {
          sock.destroy();
          if (left <= 0) {
            this.connecting = null;
            return resolve(false);
          }
          setTimeout(() => tryOnce(left - 1), delay);
        };
        sock.once('error', fail);
        sock.once('connect', () => {
          this.retries = 0;
          sock.removeListener('error', fail);
          this.sock = sock;
          sock.on('data', (d) => this._onData(d));
          sock.on('error', () => {});
          sock.on('close', () => {
            this.sock = null;
            this.emit('disconnect');
          });
          this.connecting = null;
          this.emit('connect');
          resolve(true);
        });
      };
      tryOnce(retries);
    });
    return this.connecting;
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > SERIAL_BUFFER_BYTES) {
      this.buf = this.buf.slice(this.buf.length - SERIAL_BUFFER_BYTES);
    }
    this.emit('data', d.toString('utf8'));
  }

  write(data) {
    if (!this.connected) return false;
    try {
      this.sock.write(data);
      return true;
    } catch {
      return false;
    }
  }

  /** purana output (reconnect par terminal bharna) */
  snapshot() {
    return this.buf.toString('utf8');
  }

  close() {
    this.closedByUs = true;
    if (this.sock) {
      try {
        this.sock.destroy();
      } catch {}
      this.sock = null;
    }
    this.connecting = null;
  }
}

const bridges = new Map();

function getBridge(vm, serialPath) {
  let b = bridges.get(vm.id);
  if (!b) {
    b = new SerialBridge(vm.id, serialPath);
    bridges.set(vm.id, b);
  }
  return b;
}

function dropBridge(vmId) {
  const b = bridges.get(vmId);
  if (b) {
    b.close();
    bridges.delete(vmId);
  }
}

function dropAll() {
  for (const [id] of bridges) dropBridge(id);
}

module.exports = { SerialBridge, getBridge, dropBridge, dropAll };
