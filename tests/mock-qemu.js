#!/usr/bin/env node
'use strict';
/**
 * Fake qemu-system-x86_64 — sirf testing ke liye.
 * Panel jitne bhi args deta hai, unhe "samajhta" hai aur QMP/serial sockets khol deta hai.
 * Isse hum sandbox me bhi poori VM lifecycle (start/stop/console/snapshot) test kar sakte hain.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-version')) {
  process.stdout.write('QEMU emulator version 8.2.2 (mock)\nCopyright (c) 2003-2024 Fabrice Bellard and the QEMU Project developers\n');
  process.exit(0);
}
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const qmpSpec = getArg('-qmp') || '';
const serialSpec = getArg('-serial') || '';
const pidFile = getArg('-pidfile');
const name = getArg('-name') || 'mock';

function sockPath(spec) {
  // "unix:/path,server=on,wait=off"
  const m = /^unix:([^,]+)/.exec(spec);
  return m ? m[1] : null;
}

const qmpPath = sockPath(qmpSpec);
const serialPath = sockPath(serialSpec);

if (pidFile) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
}

let exited = false;
function bye(code = 0) {
  if (exited) return;
  exited = true;
  try {
    fs.unlinkSync(pidFile);
  } catch {}
  setTimeout(() => process.exit(code), 50);
}

// ---- QMP server ----
if (qmpPath) {
  try {
    fs.unlinkSync(qmpPath);
  } catch {}
  const srv = net.createServer((sock) => {
    sock.write(JSON.stringify({ QMP: { version: { qemu: { major: 8, minor: 0, micro: 0 } }, capabilities: ['oob'] } }) + '\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const reply = (ret) => sock.write(JSON.stringify({ return: ret, id: msg.id }) + '\n');
        if (msg.execute === 'qmp_capabilities') reply({});
        else if (msg.execute === 'query-status') reply({ status: 'running', running: true, singlestep: false });
        else if (msg.execute === 'query-name') reply({ name });
        else if (msg.execute === 'system_powerdown') {
          reply({});
          setTimeout(() => bye(0), 120);
        } else if (msg.execute === 'quit') {
          reply({});
          setTimeout(() => bye(0), 30);
        } else if (msg.execute === 'human-monitor-command') {
          const cmd = String(msg.arguments && msg.arguments['command-line']);
          if (cmd.startsWith('info snapshots')) {
            reply('List of snapshots present on all disks:\nID        TAG               VM SIZE                DATE       VM CLOCK\n1         clean-install       120M 2026-01-01 10:00:00   00:00:12.345\n');
          } else if (cmd.startsWith('savevm') || cmd.startsWith('loadvm') || cmd.startsWith('delvm')) {
            reply('');
          } else reply('');
        } else reply({});
      }
    });
    sock.on('error', () => {});
  });
  srv.listen(qmpPath, () => {});
}

// ---- serial server: "boot log" ----
if (serialPath) {
  try {
    fs.unlinkSync(serialPath);
  } catch {}
  const srv = net.createServer((sock) => {
    sock.write('\r\nVPSDeck mock VM booting...\r\n');
    sock.write(`\x1b[32mubuntu login:\x1b[0m `);
    sock.on('data', (d) => {
      const t = d.toString();
      if (t.includes('\r')) sock.write(`\r\nwelcome to ${name}\r\nubuntu login: `);
      else sock.write(t);
    });
    sock.on('error', () => {});
  });
  srv.listen(serialPath, () => {});
}

// SIGTERM -> exit (panel ka forceful stop bhi test ho jaye)
process.on('SIGTERM', () => bye(0));
process.on('SIGINT', () => bye(0));

// kabhi khatam na ho
setInterval(() => {}, 1 << 30);
