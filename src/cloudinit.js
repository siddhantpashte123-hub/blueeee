'use strict';
/**
 * Cloud-init seed: VM ke pehle boot par user/password/SSH key set karta hai.
 * (Ubuntu/Debian cloud images cloud-init ke saath aate hain.)
 */
const { buildIso } = require('./iso');

const YAML_STR = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function sanitizeUser(u) {
  const name = String(u || 'ubuntu')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 24);
  return name || 'ubuntu';
}

function buildUserData(vm) {
  const user = sanitizeUser(vm.user || 'ubuntu');
  const host = String(vm.hostname || vm.name || 'vps').replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 40);
  const lines = [];
  lines.push('#cloud-config');
  lines.push(`hostname: ${host}`);
  lines.push('manage_etc_hosts: true');
  lines.push('preserve_hostname: false');
  lines.push('');
  lines.push('users:');
  lines.push(`  - name: ${user}`);
  lines.push(`    gecos: ${YAML_STR(vm.name || 'VPSDeck VM')}`);
  lines.push('    shell: /bin/bash');
  lines.push('    lock_passwd: false');
  lines.push('    sudo: ALL=(ALL) NOPASSWD:ALL');
  lines.push('    groups: [sudo, users]');
  if (Array.isArray(vm.sshKeys) && vm.sshKeys.length) {
    lines.push('    ssh_authorized_keys:');
    for (const k of vm.sshKeys) {
      const key = String(k).trim();
      if (key) lines.push(`      - ${YAML_STR(key)}`);
    }
  }
  lines.push('');
  // plain text password -> cloud-init khud hash karta hai
  lines.push('chpasswd:');
  lines.push('  expire: false');
  lines.push('  list: |');
  lines.push(`    ${user}:${String(vm.password || '').replace(/[\r\n]/g, '')}`);
  lines.push('');
  lines.push('ssh_pwauth: true');
  lines.push('disable_root: true');
  lines.push('package_update: false');
  lines.push('package_upgrade: false');
  lines.push('');
  lines.push('runcmd:');
  lines.push('  - [ sh, -c, "systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true" ]');
  lines.push('  - [ sh, -c, "echo VPSDeck-ready > /etc/vpsdeck-ready" ]');
  lines.push('');
  return lines.join('\n');
}

function buildMetaData(vm) {
  const host = String(vm.hostname || vm.name || 'vps').replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 40);
  return [
    `instance-id: ${vm.id}-${String(vm.createdAt || '').slice(-6) || '0'}`,
    `local-hostname: ${host}`,
    ''
  ].join('\n');
}

/** VM ke liye seed.iso ka Buffer */
function buildSeedIso(vm) {
  return buildIso({
    label: 'cidata',
    files: [
      { name: 'user-data', data: Buffer.from(buildUserData(vm), 'utf8') },
      { name: 'meta-data', data: Buffer.from(buildMetaData(vm), 'utf8') }
    ]
  });
}

module.exports = { buildUserData, buildMetaData, buildSeedIso, sanitizeUser };
