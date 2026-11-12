#!/usr/bin/env bash
#
# BotDeck installer — no Docker required.
#
#   sudo bash scripts/install.sh
#
# Optional environment variables:
#   APP_DIR=/opt/botdeck      installation folder
#   PORT=3000                 panel port
#   SERVICE_USER=botdeck      linux user that runs the panel + bots
#   NODE_MAJOR=22             Node.js version installed when none is present
#   NO_SYSTEMD=1              only copy files, don't install the service
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/botdeck}"
PORT="${PORT:-3000}"
SERVICE_NAME="botdeck"
SERVICE_USER="${SERVICE_USER:-botdeck}"
NODE_MAJOR="${NODE_MAJOR:-22}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root:  sudo bash scripts/install.sh"

bold ""
bold "  BotDeck installer — Docker-free bot hosting panel"
bold "  =================================================="
echo

# ------------------------------------------------------------------ node ---
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ] && "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; then
  ok "Node.js $("$NODE_BIN" -v) found"
else
  info "Node.js 18+ not found — installing Node.js ${NODE_MAJOR}.x"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh; then
      bash /tmp/nodesource_setup.sh >/dev/null 2>&1
      apt-get install -y -qq nodejs >/dev/null
    else
      warn "NodeSource script unavailable, trying the distribution package"
      apt-get install -y -qq nodejs npm >/dev/null
    fi
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    dnf install -y -q nodejs >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    yum install -y -q nodejs >/dev/null
  else
    die "Unsupported distribution. Install Node.js 18+ manually and re-run."
  fi
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || die "Node.js installation failed."
  ok "Node.js $("$NODE_BIN" -v) installed"
fi
NODE_PATH_BIN="$(command -v node)"

# --------------------------------------------------------------- helpers ---
for bin in unzip tar; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get install -y -qq "$bin" >/dev/null 2>&1 || warn "could not install $bin (archive extraction may be limited)"
    else
      warn "$bin not found — archive extraction may be limited"
    fi
  fi
done
command -v python3 >/dev/null 2>&1 || warn "python3 not found — Python bots will not start until it is installed"

# ------------------------------------------------------------------ user ---
if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "Service user '${SERVICE_USER}' exists"
else
  info "Creating system user '${SERVICE_USER}'"
  useradd --system --create-home --home-dir "/var/lib/${SERVICE_NAME}" --shell /bin/bash "$SERVICE_USER"
  ok "User '${SERVICE_USER}' created"
fi

# ------------------------------------------------------------------ copy ---
info "Installing panel to ${APP_DIR}"
mkdir -p "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude 'bots' \
      --exclude '*.log' "$SRC_DIR/" "$APP_DIR/"
  else
    find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name bots -exec rm -rf {} +
    cp -a "$SRC_DIR/." "$APP_DIR/"
    rm -rf "$APP_DIR/.git" "$APP_DIR/node_modules" "$APP_DIR/data" "$APP_DIR/bots"
  fi
fi
mkdir -p "$APP_DIR/data/logs" "$APP_DIR/bots"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
chmod 750 "$APP_DIR/data"
ok "Files installed"

# --------------------------------------------------------------- systemd ---
if [ "${NO_SYSTEMD:-0}" = "1" ]; then
  warn "NO_SYSTEMD=1 — skipping the systemd service"
else
  info "Creating systemd service '${SERVICE_NAME}'"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=BotDeck bot hosting panel (Docker-free)
Documentation=https://github.com/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=DATA_DIR=${APP_DIR}/data
Environment=BOTS_DIR=${APP_DIR}/bots
ExecStart=${NODE_PATH_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=3
# Only the panel gets SIGTERM; it stops every bot gracefully itself.
KillMode=mixed
TimeoutStopSec=25
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
  sleep 1.5

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Service is running"
  else
    warn "Service failed to start — check: journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  fi
fi

# --------------------------------------------------------------- network ---
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "ufw is active — opening port ${PORT}"
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 || warn "could not update ufw rules"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<your-server-ip>"

bold ""
bold "  ────────────────────────────────────────────────"
bold "   BotDeck is installed 🎉"
bold "  ────────────────────────────────────────────────"
echo
echo "   Panel URL : http://${IP}:${PORT}"
echo "   App dir   : ${APP_DIR}"
echo "   Data      : ${APP_DIR}/data"
echo "   Bots      : ${APP_DIR}/bots"
echo
echo "   Open the URL in your browser and create the admin password."
echo
echo "   Useful commands:"
echo "     systemctl status ${SERVICE_NAME}"
echo "     systemctl restart ${SERVICE_NAME}"
echo "     journalctl -u ${SERVICE_NAME} -f"
echo
if [ "${PORT}" = "80" ] || [ "${PORT}" = "443" ]; then
  echo "   Port ${PORT} is privileged — make sure the firewall allows it."
  echo
fi
echo "   Tip: put Nginx/Caddy in front for HTTPS and a nice domain."
echo
