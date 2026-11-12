#!/usr/bin/env bash
#
# Removes the BotDeck systemd service. Bot files and panel data are kept
# unless you pass --purge (that deletes /opt/botdeck completely).
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/botdeck}"
SERVICE_NAME="botdeck"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo bash scripts/uninstall.sh"; exit 1; }

systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
echo "✓ Service removed"

if [ "${1:-}" = "--purge" ]; then
  read -r -p "Delete ${APP_DIR} including all bots and data? [y/N] " answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    rm -rf "$APP_DIR"
    echo "✓ ${APP_DIR} deleted"
  fi
fi
