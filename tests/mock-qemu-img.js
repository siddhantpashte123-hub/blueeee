#!/usr/bin/env node
'use strict';
/** Fake qemu-img — testing ke liye (create/convert/info/resize/snapshot). */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const fileArgs = rest.filter((a) => !a.startsWith('-'));

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function info(file) {
  const st = fs.existsSync(file) ? fs.statSync(file) : null;
  return JSON.stringify({
    virtual_size: 10 * 1024 * 1024 * 1024,
    'virtual-size': 10 * 1024 * 1024 * 1024,
    'actual-size': st ? st.size : 0,
    format: 'qcow2',
    filename: file
  });
}

switch (cmd) {
  case 'create': {
    // qemu-img create -f qcow2 [-b base -F fmt] dest size
    const dest = rest.filter((a) => !a.startsWith('-'))[rest.filter((a) => !a.startsWith('-')).length - 2];
    if (!dest) fail('create: destination missing');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'QFI\xfb mock qcow2\n');
    process.stdout.write(`Formatting '${dest}', fmt=qcow2 size=...\n`);
    break;
  }
  case 'convert': {
    const src = fileArgs[fileArgs.length - 2];
    const dest = fileArgs[fileArgs.length - 1];
    if (!src || !dest || !fs.existsSync(src)) fail('convert: bad args');
    fs.copyFileSync(src, dest);
    break;
  }
  case 'info': {
    const file = fileArgs[fileArgs.length - 1];
    if (!file || !fs.existsSync(file)) fail(`qemu-img: Could not open '${file}'`);
    if (rest.includes('--output=json')) process.stdout.write(info(file));
    else process.stdout.write(`image: ${file}\nfile format: qcow2\nvirtual size: 10G\ndisk size: 1M\n`);
    break;
  }
  case 'resize': {
    const file = fileArgs[0];
    if (!fs.existsSync(file)) fail('resize: no such file');
    process.stdout.write(`Image resized.\n`);
    break;
  }
  case 'snapshot': {
    const file = fileArgs[fileArgs.length - 1];
    if (!fs.existsSync(file)) fail('snapshot: no such file');
    if (rest.includes('-l')) {
      process.stdout.write('ID        TAG                 VM SIZE                DATE       VM CLOCK\n');
      process.stdout.write('1         clean-install       123M 2026-01-01 10:00:00   00:00:12.345\n');
    }
    break;
  }
  default:
    process.stdout.write('');
}
process.exit(0);
