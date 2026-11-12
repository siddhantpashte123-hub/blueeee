'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { HttpError, sleep, shellSplit, safeJoin, formatBytes } = require('./util');

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Runs every bot as a plain child process (no containers). Each bot gets:
 *  - its own folder (bots/<id>) used as cwd + HOME
 *  - a detached process group so stop/kill takes the whole tree down
 *  - rotated log file + in-memory console buffer
 *  - crash detection, exponential-backoff auto restart, memory watchdog
 */
class Supervisor extends EventEmitter {
  constructor(store, cfg, metrics) {
    super();
    this.store = store;
    this.cfg = cfg;
    this.metrics = metrics;
    this.states = new Map();
    this.setMaxListeners(200);
  }

  botDir(id) {
    return path.join(this.cfg.BOTS_DIR, id);
  }

  logPath(id) {
    return path.join(this.cfg.LOGS_DIR, `${id}.log`);
  }

  runtimeFile() {
    return path.join(this.cfg.DATA_DIR, 'runtime.json');
  }

  state(id) {
    let s = this.states.get(id);
    if (!s) {
      s = {
        proc: null,
        pid: null,
        status: 'stopped',
        startedAt: 0,
        restarts: 0,
        gen: 0,
        starting: false,
        stopRequested: false,
        suppressRestart: false,
        restartTimer: null,
        buffer: [],
        tail: '',
        logStream: null,
        lastExit: null
      };
      this.states.set(id, s);
    }
    return s;
  }

  /* ----------------------------- logging ------------------------------ */

  _openLogStream(id) {
    const s = this.state(id);
    if (s.logStream) return s.logStream;
    const file = this.logPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const stat = fs.statSync(file);
      if (stat.size > this.cfg.LOG_MAX_BYTES) {
        try {
          fs.rmSync(`${file}.1`, { force: true });
        } catch (_) {
          /* ignore */
        }
        fs.renameSync(file, `${file}.1`);
      }
    } catch (_) {
      /* no file yet */
    }
    try {
      s.logBytes = fs.statSync(file).size;
    } catch (_) {
      s.logBytes = 0;
    }
    s.logStream = fs.createWriteStream(file, { flags: 'a' });
    s.logStream.on('error', () => {});
    return s.logStream;
  }

  _push(id, stream, chunk) {
    const s = this.state(id);
    const text = s.tail + chunk.toString('utf8');
    const lines = text.split('\n');
    s.tail = lines.pop() || '';
    for (const line of lines) this._line(id, stream, line);
    if (s.tail.length > 8192) {
      this._line(id, stream, s.tail);
      s.tail = '';
    }
  }

  _line(id, stream, message) {
    const s = this.state(id);
    const entry = { t: Date.now(), s: stream, m: message };
    s.buffer.push(entry);
    if (s.buffer.length > this.cfg.MAX_LOG_LINES) {
      s.buffer.splice(0, s.buffer.length - this.cfg.MAX_LOG_LINES);
    }
    const text = stream === 'sys' ? `[panel ${new Date().toISOString()}] ${message}\n` : `${message}\n`;
    try {
      this._openLogStream(id).write(text);
      s.logBytes = (s.logBytes || 0) + Buffer.byteLength(text);
      if (s.logBytes > this.cfg.LOG_MAX_BYTES) this._rotateLog(id);
    } catch (_) {
      /* logging must never break the panel */
    }
    this.emit('log', { id, entry });
  }

  _rotateLog(id) {
    const s = this.state(id);
    const file = this.logPath(id);
    try {
      if (s.logStream) {
        s.logStream.end();
        s.logStream = null;
      }
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    } catch (_) {
      /* ignore rotation errors */
    }
    s.logBytes = 0;
  }

  sys(id, message) {
    this._line(id, 'sys', message);
  }

  async tailLogs(id, lines = 300) {
    const file = this.logPath(id);
    let text = '';
    try {
      const handle = await fsp.open(file, 'r');
      try {
        const stat = await handle.stat();
        const maxBytes = 512 * 1024;
        const start = Math.max(0, stat.size - maxBytes);
        const length = stat.size - start;
        if (length > 0) {
          const buf = Buffer.alloc(length);
          await handle.read(buf, 0, length, start);
          text = buf.toString('utf8');
          if (start > 0) {
            const nl = text.indexOf('\n');
            if (nl !== -1) text = text.slice(nl + 1);
          }
        }
      } finally {
        await handle.close();
      }
    } catch (_) {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.length)
      .slice(-lines)
      .map((line) => ({
        t: null,
        s: line.startsWith('[panel ') ? 'sys' : 'out',
        m: line
      }));
  }

  clearLogs(id) {
    const s = this.state(id);
    s.buffer = [];
    s.tail = '';
    try {
      this._openLogStream(id);
    } catch (_) {
      /* ignore */
    }
    try {
      fs.truncateSync(this.logPath(id), 0);
    } catch (_) {
      /* ignore */
    }
    this.sys(id, 'Console cleared');
  }

  /* --------------------------- lifecycle ------------------------------ */

  _saveRuntime() {
    if (this._runtimeSave) return this._runtimeSave;
    this._runtimeSave = (async () => {
      await sleep(40);
      this._runtimeSave = null;
      const map = {};
      for (const [id, s] of this.states) {
        if (s.pid) map[id] = { pid: s.pid, startedAt: s.startedAt };
      }
      try {
        await fsp.writeFile(this.runtimeFile(), JSON.stringify(map, null, 2));
      } catch (_) {
        /* best effort */
      }
    })();
    return this._runtimeSave;
  }

  _killTree(child, signal) {
    if (!child || !child.pid) return;
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (_) {
      /* fall through */
    }
    try {
      child.kill(signal);
    } catch (_) {
      /* already gone */
    }
  }

  _killGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (_) {
      /* fall through */
    }
    try {
      process.kill(pid, signal);
    } catch (_) {
      /* already gone */
    }
  }

  /** Kill processes left behind by a hard crash of the panel. */
  async cleanupOrphans() {
    try {
      const raw = await fsp.readFile(this.runtimeFile(), 'utf8');
      const data = JSON.parse(raw);
      const entries = Object.entries(data || {});
      for (const [botId, info] of entries) {
        const pid = Number(info && info.pid);
        if (!pid) continue;
        try {
          const cwd = await fsp.readlink(`/proc/${pid}/cwd`);
          const dir = this.botDir(botId);
          if (cwd === dir || cwd.startsWith(dir + path.sep)) {
            this._killGroup(pid, 'SIGKILL');
            console.log(`[supervisor] cleaned up orphaned process ${pid} (bot ${botId})`);
          }
        } catch (_) {
          /* process is already gone */
        }
      }
    } catch (_) {
      /* no runtime file */
    }
    await this._saveRuntime();
  }

  async buildCommand(bot, dir) {
    const runtime = bot.runtime || 'node';
    const entry = String(bot.entry || '').trim();
    const extra = shellSplit(bot.args || '');

    if (runtime === 'custom') {
      if (!entry) throw new HttpError(400, 'Custom runtime needs a command in the Entry field');
      const command = extra.length ? `${entry} ${extra.map(quote).join(' ')}` : entry;
      return { cmd: '/bin/sh', args: ['-c', command], display: command };
    }

    if (!entry) throw new HttpError(400, 'Entry file is required for this runtime');
    const absolute = safeJoin(dir, entry);
    let stat = null;
    try {
      stat = await fsp.stat(absolute);
    } catch (_) {
      /* handled below */
    }
    if (!stat || !stat.isFile()) {
      throw new HttpError(400, `Entry file "${entry}" was not found in the bot folder. Upload it first.`);
    }

    if (runtime === 'node') {
      return { cmd: process.execPath, args: [absolute, ...extra], display: `node ${entry}` };
    }
    if (runtime === 'python') {
      const python = process.env.PYTHON || 'python3';
      return {
        cmd: python,
        args: ['-u', absolute, ...extra],
        display: `${path.basename(python)} ${entry}`
      };
    }
    if (runtime === 'bash') {
      return { cmd: '/bin/bash', args: [absolute, ...extra], display: `bash ${entry}` };
    }
    throw new HttpError(400, `Unknown runtime "${runtime}"`);
  }

  buildEnv(bot, dir) {
    const env = Object.assign({}, process.env);
    // The panel's own PORT must never leak into a bot (it would fight for the
    // same socket). Bots get PORT only from their own port/env settings.
    delete env.PORT;
    env.HOME = dir;
    env.PWD = dir;
    env.BOT_ID = bot.id;
    env.BOT_NAME = bot.name;
    env.BOT_DIR = dir;
    env.PYTHONUNBUFFERED = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
    if (bot.port) env.PORT = String(bot.port);
    for (const [key, value] of Object.entries(bot.env || {})) {
      if (value === undefined || value === null) continue;
      env[key] = String(value);
    }
    return env;
  }

  async start(id, opts = {}) {
    const bot = this.store.getBot(id);
    if (!bot) throw new HttpError(404, 'Bot not found');
    const s = this.state(id);
    if (s.proc) throw new HttpError(409, 'Bot is already running');
    if (s.starting) throw new HttpError(409, 'Bot is already starting');

    s.starting = true;
    try {
      if (s.restartTimer) {
        clearTimeout(s.restartTimer);
        s.restartTimer = null;
      }
      const dir = this.botDir(id);
      await fsp.mkdir(dir, { recursive: true });

      const { cmd, args, display } = await this.buildCommand(bot, dir);
      const env = this.buildEnv(bot, dir);
      this._openLogStream(id);

      const gen = ++s.gen;
      s.stopRequested = false;
      s.suppressRestart = false;
      s.status = 'starting';
      this.emit('status', { id, status: s.status });

      let child;
      try {
        child = spawn(cmd, args, {
          cwd: dir,
          env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (err) {
        s.status = 'crashed';
        this.sys(id, `Failed to spawn: ${err.message}`);
        this.emit('status', { id, status: s.status });
        throw new HttpError(500, `Could not start the bot: ${err.message}`);
      }

      s.proc = child;
      s.pid = child.pid || null;
      s.startedAt = Date.now();
      s.status = 'running';
      s.spawnError = null;

      child.stdout.on('data', (chunk) => this._push(id, 'out', chunk));
      child.stderr.on('data', (chunk) => this._push(id, 'err', chunk));
      child.stdin.on('error', () => {});
      child.on('error', (err) => {
        if (s.gen !== gen) return;
        s.spawnError = err;
        this.sys(id, `Process error: ${err.message}`);
        if (!child.pid) this._handleExit(id, s, child, null, null, err);
      });
      child.on('close', (code, signal) => {
        if (s.gen !== gen) return;
        this._handleExit(id, s, child, code, signal, s.spawnError);
      });

      if (opts.byUser) s.restarts = 0;
      this.sys(id, `Started ${display} (pid ${child.pid}) in ${dir}`);
      this.store.updateBot(id, { lastStartedAt: s.startedAt });
      this._saveRuntime().catch(() => {});
      this.emit('status', { id, status: s.status });
      return { ok: true, pid: child.pid, display };
    } finally {
      s.starting = false;
    }
  }

  _handleExit(id, s, child, code, signal, error) {
    if (s.proc !== child) return;
    const uptime = Date.now() - (s.startedAt || Date.now());
    s.proc = null;
    s.pid = null;
    s.startedAt = 0;
    s.tail = '';

    const stoppedByUser = s.stopRequested;
    const reason = error
      ? `failed to start: ${error.message}`
      : signal
        ? `signal ${signal}`
        : `code ${code}`;
    this.sys(id, `Process exited (${reason}) after ${formatDuration(uptime)}`);

    const exitInfo = {
      code: error ? null : code,
      signal: signal || null,
      at: Date.now(),
      uptime,
      reason
    };
    s.lastExit = exitInfo;

    const bot = this.store.getBot(id);
    if (bot) {
      this.store.updateBot(id, {
        lastExit: exitInfo,
        totalRuns: (bot.totalRuns || 0) + 1
      });
    }
    this._saveRuntime().catch(() => {});

    if (uptime > 60 * 1000) s.restarts = 0;

    const maxRestarts = bot ? (bot.maxRestarts ?? 10) : 0;
    const abnormal = Boolean(error) || Boolean(signal) || (code !== 0 && code !== null);
    const wantsRestart =
      bot &&
      abnormal &&
      !error &&
      !stoppedByUser &&
      !s.suppressRestart &&
      bot.autoRestart !== false &&
      maxRestarts > 0;

    if (wantsRestart) {
      s.restarts += 1;
      if (s.restarts <= maxRestarts) {
        const delay = Math.min(
          this.cfg.RESTART_BASE_DELAY * 2 ** (s.restarts - 1),
          this.cfg.RESTART_MAX_DELAY
        );
        s.status = 'restarting';
        this.sys(
          id,
          `Auto-restart in ${(delay / 1000).toFixed(1)}s (attempt ${s.restarts}/${maxRestarts})`
        );
        this.emit('status', { id, status: s.status, exit: exitInfo });
        s.restartTimer = setTimeout(() => {
          s.restartTimer = null;
          this.start(id, { auto: true }).catch((err) => {
            this.sys(id, `Auto-restart failed: ${err.message}`);
            s.status = 'crashed';
            this.emit('status', { id, status: s.status });
          });
        }, delay);
        s.restartTimer.unref?.();
        return;
      }
      this.sys(id, `Giving up after ${maxRestarts} restart attempts — fix the bot, then start it manually.`);
    }

    s.status = stoppedByUser ? 'stopped' : code || error ? 'crashed' : 'stopped';
    s.restarts = stoppedByUser ? 0 : s.restarts;
    this.emit('status', { id, status: s.status, exit: exitInfo });
  }

  async stop(id, opts = {}) {
    const s = this.state(id);
    const force = Boolean(opts.force);
    s.stopRequested = true;
    if (s.restartTimer) {
      clearTimeout(s.restartTimer);
      s.restartTimer = null;
    }

    if (!s.proc) {
      s.status = 'stopped';
      s.restarts = 0;
      this.emit('status', { id, status: s.status });
      return { ok: true, wasRunning: false };
    }

    const child = s.proc;
    s.status = 'stopping';
    this.emit('status', { id, status: s.status });

    const closed = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      setTimeout(finish, this.cfg.STOP_TIMEOUT + 3000).unref?.();
    });

    this.sys(id, force ? 'Force killing bot (SIGKILL)…' : 'Stopping bot (SIGTERM)…');
    this._killTree(child, force ? 'SIGKILL' : 'SIGTERM');

    let hardKillTimer = null;
    if (!force) {
      hardKillTimer = setTimeout(() => {
        if (s.proc === child) {
          this.sys(id, 'Bot ignored SIGTERM — sending SIGKILL');
          this._killTree(child, 'SIGKILL');
        }
      }, this.cfg.STOP_TIMEOUT);
      hardKillTimer.unref?.();
    }

    await closed;
    if (hardKillTimer) clearTimeout(hardKillTimer);

    // Give the close handler a tick to flip the status.
    for (let i = 0; i < 20 && s.proc; i++) await sleep(50);
    s.restarts = 0;
    if (!s.proc && s.status !== 'stopped') {
      s.status = 'stopped';
      this.emit('status', { id, status: s.status });
    }
    return { ok: true, wasRunning: true };
  }

  async restart(id) {
    const s = this.state(id);
    s.stopRequested = true;
    if (s.proc) await this.stop(id);
    for (let i = 0; i < 40 && s.proc; i++) await sleep(50);
    s.stopRequested = false;
    s.restarts = 0;
    return this.start(id, { byUser: true });
  }

  sendInput(id, data) {
    const s = this.state(id);
    if (!s.proc || !s.proc.stdin || !s.proc.stdin.writable) {
      throw new HttpError(409, 'Bot is not running');
    }
    s.proc.stdin.write(String(data).slice(0, 10000));
    return { ok: true };
  }

  async remove(id) {
    const s = this.states.get(id);
    if (s) {
      if (s.restartTimer) clearTimeout(s.restartTimer);
      if (s.proc) await this.stop(id).catch(() => {});
      if (s.logStream) {
        try {
          s.logStream.end();
        } catch (_) {
          /* ignore */
        }
      }
      this.states.delete(id);
    }
    try {
      await fsp.rm(this.logPath(id), { force: true });
      await fsp.rm(`${this.logPath(id)}.1`, { force: true });
    } catch (_) {
      /* ignore */
    }
    await this._saveRuntime().catch(() => {});
  }

  serialize(bot) {
    const s = this.state(bot.id);
    const running = Boolean(s.proc);
    return {
      id: bot.id,
      name: bot.name,
      runtime: bot.runtime,
      entry: bot.entry,
      args: bot.args,
      env: bot.env || {},
      port: bot.port || null,
      description: bot.description || '',
      memoryLimitMB: bot.memoryLimitMB || 0,
      autoRestart: bot.autoRestart !== false,
      maxRestarts: bot.maxRestarts ?? 10,
      autostart: Boolean(bot.autostart),
      dir: this.botDir(bot.id),
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
      lastStartedAt: bot.lastStartedAt || null,
      totalRuns: bot.totalRuns || 0,
      status: s.status || 'stopped',
      pid: running ? s.pid : null,
      uptime: running ? Date.now() - s.startedAt : 0,
      restarts: s.restarts || 0,
      lastExit: s.lastExit || bot.lastExit || null
    };
  }

  pids() {
    const map = new Map();
    for (const [id, s] of this.states) if (s.proc && s.pid) map.set(id, s.pid);
    return map;
  }

  runningCount() {
    let count = 0;
    for (const s of this.states.values()) if (s.proc) count++;
    return count;
  }

  async autostart() {
    const bots = this.store.bots.filter((b) => b.autostart);
    for (const bot of bots) {
      try {
        await this.start(bot.id, { auto: false });
        this.sys(bot.id, 'Auto-started with the panel');
      } catch (err) {
        this.sys(bot.id, `Autostart failed: ${err.message}`);
      }
      await sleep(150);
    }
    if (bots.length) console.log(`[supervisor] autostarted ${bots.length} bot(s)`);
  }

  startWatchdog() {
    this.watchdog = setInterval(() => {
      this._checkMemoryLimits().catch(() => {});
    }, this.cfg.MEMORY_CHECK_INTERVAL);
    this.watchdog.unref?.();
  }

  async _checkMemoryLimits() {
    const pids = this.pids();
    if (!pids.size) return;
    const usage = this.metrics.botUsage(pids);
    for (const [id, stats] of usage) {
      const bot = this.store.getBot(id);
      if (!bot) continue;
      const limitBytes = Number(bot.memoryLimitMB || 0) * 1024 * 1024;
      if (!limitBytes || stats.mem <= limitBytes) continue;
      this.sys(
        id,
        `Memory limit exceeded (${formatBytes(stats.mem)} > ${formatBytes(limitBytes)}) — stopping bot`
      );
      this.state(id).suppressRestart = true;
      await this.stop(id).catch(() => {});
    }
  }

  async shutdown() {
    if (this.watchdog) clearInterval(this.watchdog);
    const jobs = [];
    for (const [id, s] of this.states) {
      if (s.restartTimer) clearTimeout(s.restartTimer);
      if (s.proc) jobs.push(this.stop(id).catch(() => {}));
    }
    await Promise.race([Promise.all(jobs), sleep(6000)]);
    // Anything still alive gets a hard kill.
    for (const [, s] of this.states) {
      if (s.proc) this._killTree(s.proc, 'SIGKILL');
    }
    await this._saveRuntime().catch(() => {});
    await sleep(80);
  }
}

function quote(value) {
  return /[^\w@%+=:,./-]/.test(value) ? `'${String(value).replace(/'/g, `'\\''`)}'` : value;
}

module.exports = Supervisor;
