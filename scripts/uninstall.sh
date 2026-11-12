#!/usr/bin/env bash
#
# Removes the BotDeck systemd service. Bot files and panel data are kept
# unless you pass --purge (that deletes /opt/botdeck completely).
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/botdeck}"
SERVICE_NAME="botdeck"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo bash scripts/uninstall.sh"; exit 1; }

# systemd install
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload 2>/dev/null || true
fi

# standalone install (no systemd)
if [ -x "/usr/local/bin/${SERVICE_NAME}" ]; then
  "/usr/local/bin/${SERVICE_NAME}" stop 2>/dev/null || true
  rm -f "/usr/local/bin/${SERVICE_NAME}"
fi
rm -f "/etc/cron.d/${SERVICE_NAME}"
if command -v crontab >/dev/null 2>&1; then
  crontab -l 2>/dev/null | grep -Fv "/usr/local/bin/${SERVICE_NAME} start" | crontab - 2>/dev/null || true
fi
rm -f "${APP_DIR}/data/panel.pid"

echo "✓ Service removed"

if [ "${1:-}" = "--purge" ]; then
  read -r -p "Delete ${APP_DIR} including all bots and data? [y/N] " answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    rm -rf "$APP_DIR"
    echo "✓ ${APP_DIR} deleted"
  fi
fi
