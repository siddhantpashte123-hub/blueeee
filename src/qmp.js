'use strict';
/**
 * QEMU Machine Protocol client (unix socket, JSON).
 * Isi se VM ka status, shutdown, snapshot, etc. control karte hain.
 */
const net = require('net');
const { EventEmitter } = require('events');

class Qmp extends EventEmitter {
  constructor(socketPath, { timeout = 5000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeout = timeout;
    this.sock = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.greeted = false;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('QMP connect timeout'));
      }, this.timeout);

      const fail = (err) => {
        clearTimeout(timer);
        this.closed = true;
        sock.destroy();
        reject(err);
      };

      sock.once('error', fail);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.removeListener('error', fail);
        this.sock = sock;
        this.sock.on('error', (e) => this.emit('error', e));
        this.sock.on('close', () => {
          this.closed = true;
          this.ready = false;
          for (const [, p] of this.pending) p.reject(new Error('QMP connection closed'));
          this.pending.clear();
          this.emit('close');
        });
        this.sock.on('data', (d) => this._onData(d));
      });

      this._onGreeting = () => resolve();
      this._onGreetingReject = (e) => reject(e);
    });
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.QMP && !this.greeted) {
        this.greeted = true;
        // capabilities handshake
        this.execute('qmp_capabilities')
          .then(() => {
            this.ready = true;
            if (this._onGreeting) {
              const f = this._onGreeting;
              this._onGreeting = null;
              f();
            }
          })
          .catch((e) => {
            if (this._onGreetingReject) {
              const f = this._onGreetingReject;
              this._onGreetingReject = null;
              f(e);
            }
          });
        continue;
      }
      if (msg.event) {
        this.emit('event', msg.event, msg.data || {});
        this.emit(msg.event, msg.data || {});
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.desc || 'QMP error');
          err.qmp = msg.error;
          p.reject(err);
        } else {
          p.resolve(msg.return);
        }
      }
    }
  }

  execute(command, args) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('QMP not connected'));
      const id = this.nextId++;
      const payload = { execute: command, id };
      if (args !== undefined) payload.arguments = args;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QMP '${command}' timeout`));
      }, this.timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      try {
        this.sock.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** HMP command (human monitor) — snapshots ke liye kaam ka */
  hmp(cmd) {
    return this.execute('human-monitor-command', { 'command-line': cmd });
  }

  close() {
    this.closed = true;
    if (this.sock) {
      try {
        this.sock.end();
        this.sock.destroy();
      } catch {}
    }
  }
}

/** Ek baar connect karke ek cheez poochho (status check ke liye) */
async function query(socketPath, command, args, timeout = 3000) {
  const q = new Qmp(socketPath, { timeout });
  try {
    await q.connect();
    return await q.execute(command, args);
  } finally {
    q.close();
  }
}

module.exports = { Qmp, query };
