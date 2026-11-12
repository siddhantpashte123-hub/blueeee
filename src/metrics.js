'use strict';

const fs = require('fs');
const os = require('os');

const HZ = 100; // Linux USER_HZ
const PAGE_SIZE = 4096;

/**
 * Reads /proc once and builds a process table so we can sum an entire process
 * tree (a bot launched through a shell has children).
 */
function readProcessTable() {
  const table = new Map();
  let names;
  try {
    names = fs.readdirSync('/proc');
  } catch (_) {
    return table;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let raw;
    try {
      raw = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch (_) {
      continue;
    }
    const close = raw.lastIndexOf(')');
    if (close === -1) continue;
    const fields = raw.slice(close + 2).split(' ');
    // fields[0] = state (field 3), so /proc field N => fields[N - 3]
    const ppid = Number(fields[1]);
    const ticks = Number(fields[11]) + Number(fields[12]);
    const rssBytes = Number(fields[21]) * PAGE_SIZE;
    table.set(Number(name), { ppid, ticks, rssBytes });
  }
  return table;
}

function collectTree(rootPid, table, acc = { ticks: 0, rssBytes: 0, count: 0 }) {
  const entry = table.get(rootPid);
  if (!entry) return acc;
  acc.ticks += entry.ticks;
  acc.rssBytes += entry.rssBytes;
  acc.count += 1;
  for (const [pid, proc] of table) {
    if (proc.ppid === rootPid) collectTree(pid, table, acc);
  }
  return acc;
}

class Metrics {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.prevCpu = new Map(); // pid -> { ticks, ts }
    this.systemCpu = null; // { idle, total }
  }

  /**
   * @param {Map<string, number>} pids  botId -> pid
   * @returns {Map<string, {cpu:number, mem:number, processes:number}>}
   */
  botUsage(pids) {
    const out = new Map();
    const table = pids.size ? readProcessTable() : new Map();
    const now = Date.now();

    for (const [botId, pid] of pids) {
      if (!pid) continue;
      const tree = collectTree(pid, table);
      const prev = this.prevCpu.get(botId);
      let cpu = 0;
      if (prev && now > prev.ts && tree.ticks >= prev.ticks) {
        const seconds = (now - prev.ts) / 1000;
        cpu = ((tree.ticks - prev.ticks) / HZ / seconds) * 100;
      }
      // Normalise to total machine capacity so numbers match `top`.
      const cores = os.cpus().length || 1;
      cpu = Math.round((cpu / cores) * 10) / 10;
      this.prevCpu.set(botId, { ticks: tree.ticks, ts: now });
      out.set(botId, {
        cpu,
        mem: tree.rssBytes,
        processes: tree.count
      });
    }

    // Drop data for bots that are no longer running.
    for (const key of this.prevCpu.keys()) if (!pids.has(key)) this.prevCpu.delete(key);
    return out;
  }

  system() {
    const cpus = os.cpus();
    const load = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // whole-machine CPU utilisation from cumulative cpu times
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      const t = cpu.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    let cpuPct = 0;
    if (this.systemCpu) {
      const dIdle = idle - this.systemCpu.idle;
      const dTotal = total - this.systemCpu.total;
      if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    }
    this.systemCpu = { idle, total };

    let disk = null;
    try {
      const stat = fs.statfsSync(this.cfg.ROOT);
      const totalBytes = stat.blocks * stat.bsize;
      const freeBytes = stat.bavail * stat.bsize;
      disk = { total: totalBytes, free: freeBytes, used: totalBytes - freeBytes };
    } catch (_) {
      /* not supported */
    }

    const selfMemory = process.memoryUsage().rss;

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpuModel: cpus[0] ? cpus[0].model : 'Unknown CPU',
      cores: cpus.length,
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      load15: Math.round(load[2] * 100) / 100,
      cpu: Math.round(cpuPct * 10) / 10,
      memory: { total: totalMem, free: freeMem, used: totalMem - freeMem },
      disk,
      uptime: os.uptime(),
      nodeVersion: process.version,
      panel: {
        pid: process.pid,
        uptime: process.uptime(),
        memory: selfMemory
      }
    };
  }

  pidUsage(pid) {
    if (!pid) return null;
    const table = readProcessTable();
    const entry = table.get(pid);
    if (!entry) return null;
    return { mem: entry.rssBytes, ticks: entry.ticks };
  }
}

module.exports = Metrics;
