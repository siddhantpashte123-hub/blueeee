#!/usr/bin/env bash
#
# VPSDeck installer — kisi bhi Ubuntu/Debian VPS par (Docker ki zaroorat nahi).
#
#   curl -fsSL <url>/scripts/install.sh | sudo bash
#
# Env vars (optional):
#   APP_DIR=/opt/vpsdeck      install folder
#   PORT=8080                 panel port (auto free port agar busy ho)
#   SERVICE_USER=vpsdeck      panel chalane wala linux user
#   NO_SYSTEMD=1              systemd ko ignore karke standalone mode
#   SKIP_QEMU=1               qemu install skip (pehle se installed ho to)
#   BOTDECK_REPO / VPSDECK_REPO   github repo (archive fetch ke liye)
#   VPSDECK_REF=<sha|tag>     kaunsa version install karna hai
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vpsdeck}"
PORT="${PORT:-8080}"
SERVICE_USER="${SERVICE_USER:-vpsdeck}"
SERVICE_NAME="vpsdeck"
REPO="${VPSDECK_REPO:-${BOTDECK_REPO:-siddhantpashte123-hub/blueeee}}"
REF="${VPSDECK_REF:-main}"
NO_SYSTEMD="${NO_SYSTEMD:-0}"
SKIP_QEMU="${SKIP_QEMU:-0}"

C_OK="\033[32m"; C_WARN="\033[33m"; C_ERR="\033[31m"; C_DIM="\033[2m"; C_B="\033[1m"; C_0="\033[0m"
say()  { printf "  %b\n" "$*"; }
ok()   { printf "  ${C_OK}✓${C_0} %b\n" "$*"; }
warn() { printf "  ${C_WARN}!${C_0} %b\n" "$*"; }
die()  { printf "  ${C_ERR}✗ %b${C_0}\n" "$*"; exit 1; }
step() { printf "\n${C_B}%s${C_0}\n" "$*"; }

[ "$(id -u)" = "0" ] || die "Root se chalayein: sudo bash install.sh"

printf "\n${C_B}  VPSDeck installer${C_0}\n"
say "${C_DIM}apne VPS ke andar VPS — bina Docker${C_0}"

# ---------------------------------------------------------------- port helper
port_free() {
  local p="$1"
  node -e "
    const net=require('net');const s=net.createServer();
    s.once('error',()=>process.exit(1));
    s.once('listening',()=>s.close(()=>process.exit(0)));
    s.listen($p,'0.0.0.0');
  " 2>/dev/null
}

pick_free_port() {
  local p="$1" i=0
  while [ $i -lt 60 ]; do
    if port_free "$p"; then echo "$p"; return 0; fi
    p=$((p + 1)); i=$((i + 1))
  done
  return 1
}

# ------------------------------------------------------------------ 1. basics
step "1/7  System check"
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl >/dev/null; }
ok "root, curl available"

if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    NODE_MAJOR=0
  fi
else
  NODE_MAJOR=0
fi

if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node.js 18+ nahi mila — install kar raha hoon (NodeSource)"
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || true
    apt-get install -y -qq nodejs >/dev/null 2>&1 || true
  fi
  command -v node >/dev/null || die "Node.js install nahi hua. Manually: https://nodejs.org/"
  ok "Node.js $(node -v) install ho gaya"
else
  ok "Node.js $(node -v)"
fi

# ------------------------------------------------------------------- 2. qemu
step "2/7  QEMU (virtualization engine)"
if [ "$SKIP_QEMU" = "1" ]; then
  if command -v qemu-system-x86_64 >/dev/null; then
    ok "QEMU pehle se hai ($(qemu-system-x86_64 --version | head -1))"
  else
    warn "SKIP_QEMU=1 — QEMU install skip kiya (VM start nahi honge jab tak install na ho)"
  fi
elif command -v qemu-system-x86_64 >/dev/null && command -v qemu-img >/dev/null; then
  ok "QEMU pehle se hai ($(qemu-system-x86_64 --version | head -1))"
else
  if command -v apt-get >/dev/null; then
    say "apt se qemu install ho raha hai (2-3 minute)..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq || true
    if ! apt-get install -y -qq qemu-system-x86 qemu-utils >/dev/null 2>&1; then
      warn "qemu-system-x86 install fail — dobara try: sudo apt install -y qemu-system-x86 qemu-utils"
    fi
  else
    warn "apt-get nahi mila — QEMU manually install karein"
  fi
  if command -v qemu-system-x86_64 >/dev/null; then
    ok "QEMU install ho gaya ($(qemu-system-x86_64 --version | head -1))"
  else
    warn "QEMU missing — panel chalega par VM start nahi hoga"
  fi
fi

# KVM check
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  ok "/dev/kvm mila — VMs hardware speed par chalenge"
  KVM_OK=1
else
  warn "/dev/kvm nahi mila — VMs software mode (TCG) me chalenge, slow honge"
  say "${C_DIM}Hosting provider se nested virtualization enable karwa sakte hain.${C_0}"
  KVM_OK=0
fi

# ------------------------------------------------------------------ 3. systemd
step "3/7  Service mode"
SYSTEMD=0
if [ "$NO_SYSTEMD" != "1" ] && command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1; then
  SYSTEMD=1
  ok "systemd available — service banega ($SERVICE_NAME.service)"
else
  ok "systemd nahi hai — standalone mode (vpsdeck start/stop)"
fi

# ------------------------------------------------------------------ 4. source
step "4/7  Files copy"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SRC_DIR=""
if [ -f "$(dirname "$0")/../server.js" ]; then
  SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  ok "local folder se install: $SRC_DIR"
else
  say "GitHub se archive la raha hoon ($REPO @ $REF)..."
  URL="https://codeload.github.com/${REPO}/tar.gz/${REF}"
  if ! curl -fsSL "$URL" -o "$TMP/src.tar.gz"; then
    URL="https://codeload.github.com/${REPO}/tar.gz/refs/heads/main"
    curl -fsSL "$URL" -o "$TMP/src.tar.gz" || die "Download fail: $URL"
  fi
  tar -xzf "$TMP/src.tar.gz" -C "$TMP"
  SRC_DIR="$(find "$TMP" -maxdepth 1 -type d -name 'blueeee-*' | head -1)"
  [ -n "$SRC_DIR" ] || SRC_DIR="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)"
  ok "source mil gaya"
fi

# user
if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "user '$SERVICE_USER' pehle se hai"
else
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER" 2>/dev/null || \
    useradd -r -m -s /bin/bash "$SERVICE_USER"
  ok "user '$SERVICE_USER' bana"
fi
if getent group kvm >/dev/null 2>&1; then
  usermod -aG kvm "$SERVICE_USER" 2>/dev/null || true
  ok "'$SERVICE_USER' ko kvm group me daala"
fi

# purana panel band karo (naya port bind ho sake)
if [ -x /usr/local/bin/$SERVICE_NAME ]; then
  /usr/local/bin/$SERVICE_NAME stop >/dev/null 2>&1 || true
fi
if [ -f "$APP_DIR/data/panel.pid" ]; then
  OLDPID="$(cat "$APP_DIR/data/panel.pid" 2>/dev/null || true)"
  if [ -n "${OLDPID:-}" ] && kill -0 "$OLDPID" 2>/dev/null; then
    kill "$OLDPID" 2>/dev/null || true
    sleep 1
  fi
fi
if [ "$SYSTEMD" = "1" ] && systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
fi

# leftover qemu panels of THIS app dir
stop_old_panels() {
  local pid exe cmd
  for pid in $(pgrep -f "${APP_DIR}/server.js" 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
    case "$exe" in
      *node*) ;;
      *) continue ;;
    esac
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *install.sh*) continue ;;
    esac
    kill "$pid" 2>/dev/null || true
  done
}
stop_old_panels

mkdir -p "$APP_DIR"
PAUSED=0
if [ -f "$APP_DIR/data/panel.pid" ]; then
  P="$(cat "$APP_DIR/data/panel.pid" 2>/dev/null || true)"
  if [ -n "${P:-}" ] && kill -0 "$P" 2>/dev/null; then
    kill "$P" 2>/dev/null || true; sleep 1
  fi
fi

# data/ aur bots/ ko chhod ke copy (upgrade safe)
tar -C "$SRC_DIR" \
  --exclude='./.git' --exclude='./data' --exclude='./node_modules' \
  --exclude='./*.log' --exclude='./.arena' \
  -cf - . | tar -C "$APP_DIR" -xf -
ok "code $APP_DIR me copy ho gaya (data safe raha)"

mkdir -p "$APP_DIR/data/vms" "$APP_DIR/data/images" "$APP_DIR/data/logs"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR" 2>/dev/null || true
chmod 750 "$APP_DIR/data" 2>/dev/null || true

# ------------------------------------------------------------------- 5. port
step "5/7  Panel port"
PORT_FROM_FILE=""
if [ -f "$APP_DIR/data/port" ]; then
  PORT_FROM_FILE="$(cat "$APP_DIR/data/port" 2>/dev/null | tr -dc '0-9' || true)"
fi
PORT_EXPLICIT=0
[ -n "${PORT_OVERRIDE:-}" ] && PORT_EXPLICIT=1
# agar user ne PORT env diya hai to wo jeetta hai, warna pehle saved port
if [ -n "${PORT:-}" ] && [ "${PORT}" != "8080" ]; then
  PORT_EXPLICIT=1
elif [ -n "$PORT_FROM_FILE" ]; then
  PORT="$PORT_FROM_FILE"
fi

if port_free "$PORT"; then
  ok "port $PORT free hai"
else
  warn "port $PORT busy hai — agla free port dhoondh raha hoon"
  NEWPORT="$(pick_free_port "$((PORT + 1))" || true)"
  [ -n "$NEWPORT" ] || die "Koi free port nahi mila. PORT=9000 jaisa koi port dein."
  PORT="$NEWPORT"
  ok "port $PORT use hoga"
fi
echo "$PORT" > "$APP_DIR/data/port"
chown "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/data/port" 2>/dev/null || true

# --------------------------------------------------------------- 6. service
step "6/7  Service setup"
if [ "$SYSTEMD" = "1" ]; then
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=VPSDeck — QEMU based VPS panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=APP_DIR=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=5
# QEMU VMs ko panel ke band hone se bachaye rakhein
KillMode=process
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "systemd service chalu hai"
  else
    warn "service start nahi hui — 'journalctl -u $SERVICE_NAME -n 50' dekhein"
  fi
else
  # standalone control script
  install -d -m 755 /usr/local/bin
  cat > "/usr/local/bin/${SERVICE_NAME}" <<SVC
#!/usr/bin/env bash
# VPSDeck control script (systemd ke bina)
APP_DIR="${APP_DIR}"
NODE_BIN="$(command -v node)"
SERVICE_USER="${SERVICE_USER}"
DEFAULT_PORT="${PORT}"
PID_FILE="\$APP_DIR/data/panel.pid"
LOG_FILE="\$APP_DIR/data/panel.log"
PORT_FILE="\$APP_DIR/data/port"
SVC
  # baaki script file se jode
  sed -e '/^#!/d' -e '/^#/d' "$SRC_DIR/scripts/service.sh" >> "/usr/local/bin/${SERVICE_NAME}"
  chmod 755 "/usr/local/bin/${SERVICE_NAME}"
  /usr/local/bin/${SERVICE_NAME} start >/dev/null 2>&1 || true
  sleep 2
  if /usr/local/bin/${SERVICE_NAME} status >/dev/null 2>&1; then
    ok "standalone panel chalu hai (vpsdeck status)"
  else
    warn "panel start nahi hua — 'vpsdeck logs' dekhein"
  fi

  # reboot par khud start
  mkdir -p /etc/cron.d
  echo "@reboot root /usr/local/bin/${SERVICE_NAME} start >/dev/null 2>&1" > /etc/cron.d/${SERVICE_NAME}
  chmod 644 /etc/cron.d/${SERVICE_NAME}
  ok "reboot autostart set (/etc/cron.d/${SERVICE_NAME})"
fi

# firewall
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
  ok "ufw me port $PORT allow kiya"
fi

# ----------------------------------------------------------------- 7. verify
step "7/7  Health check"
HEALTH=""
for i in $(seq 1 25); do
  HEALTH="$(curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done
if [ -n "$HEALTH" ]; then
  ok "panel live hai: $HEALTH"
else
  warn "health check fail — 'vpsdeck logs' (standalone) ya 'journalctl -u $SERVICE_NAME' dekhein"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
printf "\n${C_B}  Ho gaya! 🎉${C_0}\n\n"
printf "  ${C_B}Panel URL :${C_0}  http://%s:%s\n" "${IP:-<server-ip>}" "$PORT"
printf "  ${C_B}Local URL :${C_0}  http://localhost:%s\n" "$PORT"
printf "  ${C_B}App dir   :${C_0}  %s\n" "$APP_DIR"
printf "  ${C_B}Port      :${C_0}  %s\n" "$PORT"
printf "  ${C_B}Accel     :${C_0}  %s\n" "$([ "$KVM_OK" = "1" ] && echo 'KVM (fast)' || echo 'TCG (software — slow)')"
printf "\n  ${C_B}Pehle kya karein:${C_0}\n"
printf "   1. Browser me panel kholein aur admin password set karein\n"
printf "   2. 'OS Images' page me Ubuntu/Alpine image download karein\n"
printf "   3. '+ Naya VPS' dabayein — 30 second me VM ban jayega\n"
printf "\n  ${C_B}Commands:${C_0}  vpsdeck start | stop | restart | status | logs | port <n>\n"
printf "  ${C_B}Public access nahi hai?${C_0} ssh -p 443 -R0:localhost:%s a.pinggy.io\n\n" "$PORT"
