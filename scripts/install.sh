#!/usr/bin/env bash
#
# BotDeck installer — no Docker required.
#
# From a cloned repository:
#   sudo bash scripts/install.sh
#
# One-liner (downloads the source automatically):
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/scripts/install.sh | sudo bash
#
# Optional environment variables:
#   APP_DIR=/opt/botdeck      installation folder
#   PORT=3000                 panel port
#   SERVICE_USER=botdeck      linux user that runs the panel + bots
#   NODE_MAJOR=22             Node.js version installed when none is present
#   NO_SYSTEMD=1              only copy files, don't install the service
#   BOTDECK_REPO=owner/repo   GitHub repository used by the one-liner
#   BOTDECK_REF=branch        git ref (branch/tag/sha) used by the one-liner
#
set -euo pipefail

INSTALLER_VERSION="2.1"

APP_DIR="${APP_DIR:-/opt/botdeck}"
PORT="${PORT:-3000}"
SERVICE_NAME="botdeck"
SERVICE_USER="${SERVICE_USER:-botdeck}"
NODE_MAJOR="${NODE_MAJOR:-22}"

REPO="${BOTDECK_REPO:-siddhantpashte123-hub/blueeee}"
SOURCE_REF="${BOTDECK_REF:-}"
FALLBACK_REFS=("main" "arena/ac969ea0-blueeee")

# When the script is piped into bash there is no checkout next to it, so the
# source is downloaded from GitHub instead.
SELF="${BASH_SOURCE[0]:-}"
SRC_DIR=""
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  CANDIDATE="$(cd "$(dirname "$SELF")/.." 2>/dev/null && pwd || true)"
  if [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE/server.js" ]; then
    SRC_DIR="$CANDIDATE"
  fi
fi

TMP_ROOT=""
cleanup() {
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then rm -rf "$TMP_ROOT"; fi
}
trap cleanup EXIT

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root:  sudo bash scripts/install.sh"

bold ""
bold "  BotDeck installer v${INSTALLER_VERSION} — Docker-free bot hosting panel"
bold "  =================================================="
echo

# ----------------------------------------------------------------- source ---
fetch_tarball() {
  local ref="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    # branch/tag name, then a raw commit sha, then the API as last resort
    curl -fsSL --connect-timeout 15 --max-time 180 \
      "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${ref}" -o "$dest" 2>/dev/null && return 0
    curl -fsSL --connect-timeout 15 --max-time 180 \
      "https://codeload.github.com/${REPO}/tar.gz/${ref}" -o "$dest" 2>/dev/null && return 0
    curl -fsSL --connect-timeout 15 --max-time 180 \
      -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${REPO}/tarball/${ref}" -o "$dest" 2>/dev/null && return 0
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 30 -O "$dest" "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${ref}" 2>/dev/null && return 0
    wget -q -T 30 -O "$dest" "https://codeload.github.com/${REPO}/tar.gz/${ref}" 2>/dev/null && return 0
    wget -q -T 30 -O "$dest" "https://api.github.com/repos/${REPO}/tarball/${ref}" 2>/dev/null && return 0
  fi
  return 1
}

download_source() {
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    die "curl or wget is required to download the source"
  fi

  local refs=()
  if [ -n "$SOURCE_REF" ]; then refs+=("$SOURCE_REF"); fi
  refs+=("${FALLBACK_REFS[@]}")

  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/botdeck-src.XXXXXX")"
  info "Downloading BotDeck from github.com/${REPO}"

  local ref archive dir
  for ref in "${refs[@]}"; do
    archive="$TMP_ROOT/botdeck.tar.gz"
    rm -rf "$TMP_ROOT/extract"
    mkdir -p "$TMP_ROOT/extract"
    if fetch_tarball "$ref" "$archive" && tar -xzf "$archive" -C "$TMP_ROOT/extract" 2>/dev/null; then
      dir="$(find "$TMP_ROOT/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
      if [ -n "$dir" ] && [ -f "$dir/server.js" ]; then
        SRC_DIR="$dir"
        ok "Source downloaded (${ref})"
        return 0
      fi
    fi
    warn "ref '${ref}' is not usable — trying the next one"
  done

  die "Could not download BotDeck. Check BOTDECK_REPO / BOTDECK_REF, or clone the repo and run: sudo bash scripts/install.sh"
}

if [ -z "$SRC_DIR" ]; then
  download_source
else
  ok "Using local source: ${SRC_DIR}"
fi

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

# --------------------------------------------------------------- service ---
# systemd is great when it exists, but plenty of VPS/containers don't have it.
# In that case BotDeck installs a tiny `botdeck` control script + cron autostart.
SYSTEMD_OK=0
if [ "${NO_SYSTEMD:-0}" != "1" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl show-environment >/dev/null 2>&1; then
    SYSTEMD_OK=1
  fi
fi

install_systemd_service() {
  info "Creating systemd service '${SERVICE_NAME}'"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=BotDeck bot hosting panel (Docker-free)
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
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 1.5

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Service is running"
  else
    warn "Service failed to start — check: journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  fi
}

install_standalone() {
  local cli="/usr/local/bin/${SERVICE_NAME}"

  info "systemd not detected — using standalone process control"
  [ -f "${APP_DIR}/scripts/service.sh" ] || die "scripts/service.sh is missing from the installation"

  sed -e "s|__APP_DIR__|${APP_DIR}|g" \
      -e "s|__NODE_BIN__|${NODE_PATH_BIN}|g" \
      -e "s|__PORT__|${PORT}|g" \
      -e "s|__SERVICE_USER__|${SERVICE_USER}|g" \
      -e "s|__SERVICE_NAME__|${SERVICE_NAME}|g" \
      "${APP_DIR}/scripts/service.sh" > "$cli"
  chmod 755 "$cli"
  ok "Control script installed: ${cli}"

  "$cli" stop >/dev/null 2>&1 || true
  if "$cli" start; then
    ok "Panel started"
  else
    warn "Panel did not start — check: ${SERVICE_NAME} logs"
  fi

  # Best-effort autostart without systemd.
  local start_cron="su -s /bin/bash ${SERVICE_USER} -c '${cli} start' >/dev/null 2>&1"
  if [ -d /etc/cron.d ]; then
    cat > "/etc/cron.d/${SERVICE_NAME}" <<EOF
# Start BotDeck at boot (no systemd on this host)
@reboot root ${start_cron}
EOF
    chmod 644 "/etc/cron.d/${SERVICE_NAME}"
    ok "Autostart entry added: /etc/cron.d/${SERVICE_NAME} (needs a running cron daemon)"
  elif command -v crontab >/dev/null 2>&1; then
    ( crontab -l 2>/dev/null | grep -Fv "${cli} start"; echo "@reboot ${start_cron}" ) | crontab - || true
    ok "Autostart entry added to the root crontab (needs a running cron daemon)"
  else
    warn "No cron found — BotDeck will not start automatically after a reboot"
  fi
}

if [ "$SYSTEMD_OK" = "1" ]; then
  install_systemd_service
else
  install_standalone
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
if [ "$SYSTEMD_OK" = "1" ]; then
  echo "   Useful commands:"
  echo "     systemctl status ${SERVICE_NAME}"
  echo "     systemctl restart ${SERVICE_NAME}"
  echo "     journalctl -u ${SERVICE_NAME} -f"
else
  echo "   Useful commands (no systemd):"
  echo "     ${SERVICE_NAME} status"
  echo "     ${SERVICE_NAME} restart"
  echo "     ${SERVICE_NAME} logs"
  echo "     tail -f ${APP_DIR}/data/panel.log"
fi
echo
if [ "${PORT}" = "80" ] || [ "${PORT}" = "443" ]; then
  echo "   Port ${PORT} is privileged — make sure the firewall allows it."
  echo
fi
echo "   Tip: put Nginx/Caddy in front for HTTPS and a nice domain."
echo
