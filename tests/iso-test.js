#!/usr/bin/env node
'use strict';
/**
 * ISO writer + cloud-init ke liye structural test (koi external tool nahi).
 * node tests/iso-test.js
 */
const assert = require('assert');
const { buildIso } = require('../src/iso');
const { buildSeedIso, buildUserData } = require('../src/cloudinit');

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name} — ${e.message}`);
  }
}

const SECTOR = 2048;
const u32le = (b, o) => b.readUInt32LE(o);
const u32be = (b, o) => b.readUInt32BE(o);

console.log('\n[ISO9660 writer]');
const files = [
  { name: 'user-data', data: Buffer.from('#cloud-config\nhostname: test\n') },
  { name: 'meta-data', data: Buffer.from('instance-id: abc\n') }
];
const iso = buildIso({ label: 'cidata', files });

check('PVD sector 16 par hai', () => {
  const pvd = 16 * SECTOR;
  assert.strictEqual(iso[pvd], 1);
  assert.strictEqual(iso.slice(pvd + 1, pvd + 6).toString(), 'CD001');
  assert.strictEqual(iso[pvd + 6], 1);
});

check('volume label "cidata" (blkid compatible)', () => {
  const pvd = 16 * SECTOR;
  const label = iso.slice(pvd + 40, pvd + 72).toString('ascii').trim();
  assert.strictEqual(label, 'cidata');
});

check('Joliet SVD sector 17 par (%/E escape)', () => {
  const svd = 17 * SECTOR;
  assert.strictEqual(iso[svd], 2);
  assert.strictEqual(iso.slice(svd + 1, svd + 6).toString(), 'CD001');
  assert.strictEqual(iso.slice(svd + 88, svd + 91).toString('ascii'), '%/E');
});

check('volume descriptor terminator sector 18', () => {
  assert.strictEqual(iso[18 * SECTOR], 255);
});

check('volume space size sahi hai', () => {
  const pvd = 16 * SECTOR;
  const le = u32le(iso, pvd + 80);
  const be = u32be(iso, pvd + 84);
  assert.strictEqual(le, iso.length / SECTOR);
  assert.strictEqual(be, le);
});

check('path tables (L aur M) match karte hain', () => {
  const pvd = 16 * SECTOR;
  const size = u32le(iso, pvd + 132);
  const lLoc = u32le(iso, pvd + 140);
  const mLoc = u32be(iso, pvd + 148);
  assert.strictEqual(iso[lLoc * SECTOR], 1); // root dir identifier length
  assert.strictEqual(iso[mLoc * SECTOR], 1);
  assert.strictEqual(u32le(iso, lLoc * SECTOR + 2), u32be(iso, mLoc * SECTOR + 2));
  assert.strictEqual(size, 10);
});

check('root directory me dono files hain', () => {
  const pvd = 16 * SECTOR;
  const rootExtent = u32le(iso, pvd + 156 + 2);
  const rootSize = u32le(iso, pvd + 156 + 10);
  const names = [];
  let off = rootExtent * SECTOR;
  const end = off + rootSize;
  while (off < end) {
    const len = iso[off];
    if (!len) {
      off = (Math.floor(off / SECTOR) + 1) * SECTOR;
      continue;
    }
    const nameLen = iso[off + 32];
    const name = iso.slice(off + 33, off + 33 + nameLen).toString('ascii');
    if (name && name !== '\u0000' && name !== '\u0001') names.push(name);
    off += len;
  }
  // ISO9660 namespace 8.3 hai (Joliet me poora naam hota hai — agla check)
  assert.ok(names.some((n) => n.startsWith('USER-DAT')), `names: ${names.join(',')}`);
  assert.ok(names.some((n) => n.startsWith('META-DAT')), names.join(','));
});

check('file data sahi jagah par hai (ISO name se padho)', () => {
  const pvd = 16 * SECTOR;
  const rootExtent = u32le(iso, pvd + 156 + 2);
  let off = rootExtent * SECTOR;
  const found = {};
  while (off < rootExtent * SECTOR + SECTOR) {
    const len = iso[off];
    if (!len) break;
    const nameLen = iso[off + 32];
    const name = iso.slice(off + 33, off + 33 + nameLen).toString('ascii');
    const extent = u32le(iso, off + 2);
    const size = u32le(iso, off + 10);
    if (name.startsWith('USER')) found.user = iso.slice(extent * SECTOR, extent * SECTOR + size).toString();
    if (name.startsWith('META')) found.meta = iso.slice(extent * SECTOR, extent * SECTOR + size).toString();
    off += len;
  }
  assert.ok(found.user.startsWith('#cloud-config'));
  assert.ok(found.meta.includes('instance-id'));
});

check('Joliet names lowercase hain (cloud-init ke liye)', () => {
  const svd = 17 * SECTOR;
  const rootExtent = u32le(iso, svd + 156 + 2);
  let off = rootExtent * SECTOR;
  const names = [];
  while (off < rootExtent * SECTOR + SECTOR) {
    const len = iso[off];
    if (!len) break;
    const nameLen = iso[off + 32];
    const raw = iso.slice(off + 33, off + 33 + nameLen);
    let nm = '';
    for (let i = 0; i + 1 < raw.length; i += 2) nm += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
    if (nm && nm !== '\u0000' && nm !== '\u0001') names.push(nm);
    off += len;
  }
  assert.ok(names.includes('user-data'), names.join(','));
  assert.ok(names.includes('meta-data'), names.join(','));
});

console.log('\n[cloud-init]');
const vm = {
  id: 'vm-test-123456',
  name: 'my vps',
  hostname: 'my-vps',
  user: 'ubuntu',
  password: 'secret12345',
  sshKeys: ['ssh-ed25519 AAAAC3NzaTESTKEY user@host'],
  createdAt: Date.now()
};

check('user-data me user + password set hai', () => {
  const ud = buildUserData(vm);
  assert.ok(ud.startsWith('#cloud-config'));
  assert.ok(/name: ubuntu/.test(ud));
  assert.ok(/ubuntu:secret12345/.test(ud));
  assert.ok(/ssh_pwauth: true/.test(ud));
  assert.ok(/lock_passwd: false/.test(ud));
  assert.ok(/sudo: ALL=\(ALL\) NOPASSWD:ALL/.test(ud));
});

check('SSH key YAML me quoted hai', () => {
  const ud = buildUserData(vm);
  assert.ok(/ssh_authorized_keys:/.test(ud));
  assert.ok(/"ssh-ed25519 AAAAC3NzaTESTKEY user@host"/.test(ud));
});

check('khatarnak naam/keys escape hote hain', () => {
  const ud = buildUserData({
    ...vm,
    user: 'bad user;rm -rf /',
    hostname: 'x"y',
    sshKeys: ['key "with quote"']
  });
  assert.ok(!/bad user/.test(ud), 'user sanitised');
  assert.ok(ud.includes('name: baduserrm'), ud.slice(0, 400));
  assert.ok(ud.includes('\\"with quote\\"'));
});

check('seed ISO ban raha hai aur label cidata hai', () => {
  const seed = buildSeedIso(vm);
  assert.strictEqual(seed.slice(16 * SECTOR + 1, 16 * SECTOR + 6).toString(), 'CD001');
  assert.strictEqual(seed.slice(16 * SECTOR + 40, 16 * SECTOR + 46).toString(), 'cidata');
  assert.ok(seed.length > 20 * SECTOR);
});

console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${pass}/${pass + failures.length} ISO checks pass\x1b[0m\n`);
process.exit(failures.length ? 1 : 0);
