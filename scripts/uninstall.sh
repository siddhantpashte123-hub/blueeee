#!/usr/bin/env bash
# VPSDeck uninstaller
#   sudo bash scripts/uninstall.sh           -> panel hata do, data/VMs chhod do
#   sudo bash scripts/uninstall.sh --purge   -> sab kuch (VMs ke disks bhi) delete
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/vpsdeck}"
SERVICE_USER="${SERVICE_USER:-vpsdeck}"
SERVICE_NAME="vpsdeck"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

c_ok="\033[32m"; c_warn="\033[33m"; c_0="\033[0m"
ok() { printf "  ${c_ok}✓${c_0} %s\n" "$*"; }
warn() { printf "  ${c_warn}!${c_0} %s\n" "$*"; }

[ "$(id -u)" = "0" ] || { echo "sudo se chalayein"; exit 1; }

echo "VPSDeck uninstall..."
# systemd
if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload 2>/dev/null || true
  ok "systemd service hata di"
fi

# standalone
if [ -x "/usr/local/bin/${SERVICE_NAME}" ]; then
  "/usr/local/bin/${SERVICE_NAME}" stop >/dev/null 2>&1 || true
  rm -f "/usr/local/bin/${SERVICE_NAME}"
  ok "vpsdeck command hata di"
fi
rm -f "/etc/cron.d/${SERVICE_NAME}" && ok "autostart cron hata di"

# chalte panel
if [ -f "$APP_DIR/data/panel.pid" ]; then
  PID="$(cat "$APP_DIR/data/panel.pid" 2>/dev/null | tr -dc '0-9')"
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
fi

# chalte VMs
if [ -d "$APP_DIR/data/vms" ]; then
  for p in "$APP_DIR"/data/vms/*/qemu.pid; do
    [ -f "$p" ] || continue
    VP="$(cat "$p" 2>/dev/null | tr -dc '0-9')"
    [ -n "${VP:-}" ] && kill "$VP" 2>/dev/null || true
  done
  ok "chalte VMs band kiye"
fi

if [ "$PURGE" = "1" ]; then
  rm -rf "$APP_DIR"
  ok "$ APP_DIR poora delete ho gaya (VMs, images, panel config)"
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    userdel -r "$SERVICE_USER" 2>/dev/null || true
    ok "user '$SERVICE_USER' hata diya"
  fi
else
  rm -rf "$APP_DIR/scripts" "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/server.js" "$APP_DIR/package.json" "$APP_DIR/README.md"
  ok "code hata diya — data/ aur VMs '$APP_DIR/data' me safe hain"
  warn "poora delete karna ho to: sudo bash scripts/uninstall.sh --purge"
fi

echo
echo "QEMU system par install rahega (dusre kaam aa sakta hai)."
echo "Hataana ho to: sudo apt remove --purge qemu-system-x86 qemu-utils"
