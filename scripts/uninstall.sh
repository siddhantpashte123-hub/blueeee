#!/usr/bin/env bash
# Forge uninstaller
#   sudo bash scripts/uninstall.sh           -> panel hatao, data (models/chats) rakho
#   sudo bash scripts/uninstall.sh --purge   -> sab delete (models, chats, workspace)
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/forge}"
SERVICE_USER="${SERVICE_USER:-forge}"
SERVICE_NAME="forge"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

c_ok="\033[32m"; c_warn="\033[33m"; c_0="\033[0m"
ok() { printf "  ${c_ok}✓${c_0} %s\n" "$*"; }
warn() { printf "  ${c_warn}!${c_0} %s\n" "$*"; }

[ "$(id -u)" = "0" ] || { echo "sudo se chalayein"; exit 1; }
echo "Forge uninstall..."

if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload 2>/dev/null || true
  ok "systemd service hataayi"
fi

if [ -x "/usr/local/bin/${SERVICE_NAME}" ]; then
  "/usr/local/bin/${SERVICE_NAME}" stop >/dev/null 2>&1 || true
  rm -f "/usr/local/bin/${SERVICE_NAME}"
  ok "forge command hataayi"
fi
rm -f "/etc/cron.d/${SERVICE_NAME}" 2>/dev/null && ok "autostart hataaya" || true

if [ -f "$APP_DIR/data/panel.pid" ]; then
  P="$(tr -dc '0-9' < "$APP_DIR/data/panel.pid" 2>/dev/null)"
  [ -n "${P:-}" ] && kill "$P" 2>/dev/null || true
fi

if [ "$PURGE" = "1" ]; then
  rm -rf "$APP_DIR"
  ok "$APP_DIR poora delete (models + chats + workspace)"
  id "$SERVICE_USER" >/dev/null 2>&1 && userdel -r "$SERVICE_USER" 2>/dev/null && ok "user hataaya"
else
  rm -rf "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/scripts" "$APP_DIR/server.js" "$APP_DIR/package.json" "$APP_DIR/README.md"
  ok "code hataaya — data/ (models, chats, aapka code) safe hai"
  warn "poora delete: sudo bash scripts/uninstall.sh --purge"
fi
