#!/usr/bin/env bash
#
# Forge installer — local AI code studio, aapke VPS par (port 4040).
# Docker / GPU / API key ki zaroorat nahi.
#
#   curl -fsSL <url>/scripts/install.sh | sudo bash
#
# Env vars:
#   APP_DIR=/opt/forge      install folder
#   PORT=4040               panel port
#   SERVICE_USER=forge      linux user
#   MODEL=qwen2.5-coder-1.5b   kaunsa model download karna hai
#   SKIP_MODEL=1            model download skip (panel se baad me kar sakte hain)
#   SKIP_LLAMA=1            llama.cpp download skip (agar pehle se hai)
#   NO_SYSTEMD=1            standalone mode
#   FORGE_REPO / FORGE_REF  github source
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/forge}"
PORT="${PORT:-4040}"
SERVICE_USER="${SERVICE_USER:-forge}"
SERVICE_NAME="forge"
REPO="${FORGE_REPO:-siddhantpashte123-hub/blueeee}"
REF="${FORGE_REF:-main}"
MODEL="${MODEL:-auto}"
SKIP_MODEL="${SKIP_MODEL:-0}"
SKIP_LLAMA="${SKIP_LLAMA:-0}"
NO_SYSTEMD="${NO_SYSTEMD:-0}"

C_OK="\033[32m"; C_WARN="\033[33m"; C_ERR="\033[31m"; C_DIM="\033[2m"; C_B="\033[1m"; C_0="\033[0m"
say()  { printf "  %b\n" "$*"; }
ok()   { printf "  ${C_OK}✓${C_0} %b\n" "$*"; }
warn() { printf "  ${C_WARN}!${C_0} %b\n" "$*"; }
die()  { printf "  ${C_ERR}✗ %b${C_0}\n" "$*"; exit 1; }
step() { printf "\n${C_B}%s${C_0}\n" "$*"; }

[ "$(id -u)" = "0" ] || die "Root se chalayein: sudo bash install.sh"

printf "\n${C_B}  Forge installer${C_0}\n"
say "${C_DIM}local AI code studio — aapka model, aapka code, aapka server${C_0}"

# ------------------------------------------------------------------ helpers
port_free() {
  node -e "
    const n=require('net');const s=n.createServer();
    s.once('error',()=>process.exit(1));
    s.once('listening',()=>s.close(()=>process.exit(0)));
    s.listen($1,'0.0.0.0');" 2>/dev/null
}
pick_free_port() {
  local p="$1" i=0
  while [ $i -lt 60 ]; do
    port_free "$p" && { echo "$p"; return 0; }
    p=$((p+1)); i=$((i+1))
  done
  return 1
}
ram_mb() { awk '/MemTotal/{print int($2/1024)}' /proc/meminfo; }

# ------------------------------------------------------------------ 1. node
step "1/7  Node.js"
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl >/dev/null; }
NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  warn "Node 18+ nahi mila — install kar raha hoon"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || true
  apt-get install -y -qq nodejs >/dev/null 2>&1 || true
fi
command -v node >/dev/null || die "Node.js install nahi hua (https://nodejs.org)"
ok "Node $(node -v)"

for bin in tar gzip curl; do command -v $bin >/dev/null || apt-get install -y -qq $bin >/dev/null 2>&1 || true; done

# ------------------------------------------------------------------ 2. user
step "2/7  System user"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "user '$SERVICE_USER' pehle se hai"
else
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER" 2>/dev/null || useradd -r -m -s /bin/bash "$SERVICE_USER"
  ok "user '$SERVICE_USER' bana"
fi

# ------------------------------------------------------------------ 3. source
step "3/7  Files"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -f "$(dirname "$0")/../server.js" ]; then
  SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  ok "local folder se install: $SRC_DIR"
else
  say "GitHub se archive aa raha hai ($REPO @ $REF)..."
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" -o "$TMP/src.tar.gz" || \
    curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/main" -o "$TMP/src.tar.gz" || die "Download fail"
  tar -xzf "$TMP/src.tar.gz" -C "$TMP"
  SRC_DIR="$(find "$TMP" -maxdepth 2 -name server.js -printf '%h\n' | head -1)"
  [ -n "$SRC_DIR" ] || die "Source extract nahi hua"
  ok "source mil gaya"
fi

# purana panel band
if [ -x "/usr/local/bin/${SERVICE_NAME}" ]; then "/usr/local/bin/${SERVICE_NAME}" stop >/dev/null 2>&1 || true; fi
if [ "$NO_SYSTEMD" != "1" ] && command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
fi

mkdir -p "$APP_DIR"
tar -C "$SRC_DIR" --exclude='./.git' --exclude='./data' --exclude='./node_modules' --exclude='./*.log' --exclude='./.arena' \
  -cf - . | tar -C "$APP_DIR" -xf -
mkdir -p "$APP_DIR/data/models" "$APP_DIR/data/chats" "$APP_DIR/data/bin" "$APP_DIR/data/workspace"
ok "code $APP_DIR me (data/ safe)"

chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR" 2>/dev/null || true

# ------------------------------------------------------------------ 4. llama.cpp
step "4/7  AI engine (llama.cpp)"
ENGINE="$APP_DIR/data/bin/llama.cpp"
WRAPPER="$APP_DIR/data/bin/llama-server"
if [ -x "$WRAPPER" ] && [ "$SKIP_LLAMA" != "1" ]; then
  ok "llama-server pehle se installed hai"
elif [ "$SKIP_LLAMA" = "1" ]; then
  warn "SKIP_LLAMA=1 — engine download skip"
else
  say "GitHub se latest prebuilt llama.cpp laa raha hoon (~25 MB)..."
  TAG="$(curl -fsSL "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=5" 2>/dev/null \
        | grep -o '"tag_name": *"b[0-9]*"' | head -1 | grep -o 'b[0-9]*' || true)"
  [ -n "${TAG:-}" ] || die "llama.cpp release tag nahi mila (internet check karein)"
  URL="https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/llama-${TAG}-bin-ubuntu-x64.tar.gz"
  say "  $URL"
  if curl -fL --retry 2 -# "$URL" -o "$TMP/llama.tar.gz" 2>/dev/null; then
    rm -rf "$ENGINE"; mkdir -p "$ENGINE"
    tar -xzf "$TMP/llama.tar.gz" -C "$ENGINE" 2>/dev/null || warn "archive extract me dikkat"
    REAL="$(find "$ENGINE" -type f -name llama-server -perm -u+x | head -1)"
    if [ -n "$REAL" ]; then
      cat > "$WRAPPER" <<WRAP
#!/usr/bin/env bash
# llama.cpp wrapper — shared libs sahi jagah se load ho
D="\$(dirname "\$(readlink -f "\$0")")/llama.cpp"
BIN="\$(dirname "\$(readlink -f "$REAL")")"
export LD_LIBRARY_PATH="\$BIN:\$D:\${LD_LIBRARY_PATH:-}"
exec "\$BIN/llama-server" "\$@"
WRAP
      chmod +x "$WRAPPER"
      ok "llama-server install ho gaya ($($WRAPPER --version 2>/dev/null | head -1 || echo "$TAG"))"
    else
      warn "archive me llama-server nahi mila — panel se HTTPS engine ka intezaar karein"
    fi
  else
    warn "llama.cpp download fail — baad me dobara chalayein ya LLM_URL se dur ka engine use karein"
  fi
fi

# ------------------------------------------------------------------ 5. model
step "5/7  Model"
RAM="$(ram_mb)"
if [ "$MODEL" = "auto" ]; then
  if [ "$RAM" -lt 2600 ]; then MODEL="qwen2.5-coder-0.5b"
  elif [ "$RAM" -lt 5000 ]; then MODEL="qwen2.5-coder-1.5b"
  elif [ "$RAM" -lt 9000 ]; then MODEL="qwen2.5-coder-3b"
  else MODEL="qwen2.5-coder-7b"; fi
fi
case "$MODEL" in
  qwen2.5-coder-0.5b) M_URL="https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf?download=true"; M_FILE="qwen2.5-coder-0.5b-instruct-q4_k_m.gguf"; M_GB="0.4" ;;
  qwen2.5-coder-1.5b) M_URL="https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf?download=true"; M_FILE="qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"; M_GB="1.0" ;;
  qwen2.5-coder-3b)   M_URL="https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf?download=true"; M_FILE="qwen2.5-coder-3b-instruct-q4_k_m.gguf"; M_GB="1.9" ;;
  qwen2.5-coder-7b)   M_URL="https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf?download=true"; M_FILE="qwen2.5-coder-7b-instruct-q4_k_m.gguf"; M_GB="4.7" ;;
  llama-3.2-3b)       M_URL="https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf?download=true"; M_FILE="llama-3.2-3b-instruct-q4_k_m.gguf"; M_GB="2.0" ;;
  *) die "Unknown MODEL=$MODEL (qwen2.5-coder-0.5b|1.5b|3b|7b|llama-3.2-3b)" ;;
esac

if [ "$SKIP_MODEL" = "1" ]; then
  warn "SKIP_MODEL=1 — model baad me panel ke 'Models' page se download karein"
elif [ -f "$APP_DIR/data/models/$M_FILE" ]; then
  ok "model pehle se hai: $M_FILE"
else
  say "Model: $MODEL (~${M_GB} GB) — RAM ${RAM} MB ke hisaab se chuna gaya"
  say "${C_DIM}HuggingFace se download ho raha hai, 2-10 minute lag sakte hain...${C_0}"
  if curl -fL --retry 2 -# "$M_URL" -o "$APP_DIR/data/models/$M_FILE.part" 2>/dev/null; then
    mv "$APP_DIR/data/models/$M_FILE.part" "$APP_DIR/data/models/$M_FILE"
    ok "model download ho gaya"
  else
    rm -f "$APP_DIR/data/models/$M_FILE.part" 2>/dev/null || true
    warn "model download fail — panel ke Models page se try karein"
  fi
fi
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/data" 2>/dev/null || true

# ------------------------------------------------------------------ 6. port + service
step "6/7  Service"
PORT_FROM_FILE=""
[ -f "$APP_DIR/data/port" ] && PORT_FROM_FILE="$(tr -dc '0-9' < "$APP_DIR/data/port" || true)"
[ -n "$PORT_FROM_FILE" ] && [ "$PORT" = "4040" ] && PORT="$PORT_FROM_FILE"
if ! port_free "$PORT"; then
  warn "port $PORT busy hai"
  NEW="$(pick_free_port $((PORT+1)) || true)"
  [ -n "$NEW" ] || die "free port nahi mila"
  PORT="$NEW"
fi
echo "$PORT" > "$APP_DIR/data/port"
ok "panel port: $PORT"

SYSTEMD=0
if [ "$NO_SYSTEMD" != "1" ] && command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1; then SYSTEMD=1; fi

if [ "$SYSTEMD" = "1" ]; then
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Forge — local AI code studio
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=APP_DIR=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=5
KillMode=process
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 2
  systemctl is-active --quiet "$SERVICE_NAME" && ok "systemd service chalu" || warn "service start nahi hui — journalctl -u $SERVICE_NAME"
else
  install -d -m 755 /usr/local/bin
  {
    cat <<SVC
#!/usr/bin/env bash
APP_DIR="${APP_DIR}"
NODE_BIN="$(command -v node)"
SERVICE_USER="${SERVICE_USER}"
DEFAULT_PORT="${PORT}"
PID_FILE="\$APP_DIR/data/panel.pid"
LOG_FILE="\$APP_DIR/data/panel.log"
PORT_FILE="\$APP_DIR/data/port"
SVC
    sed -e '/^#!/d' -e '/^#/d' "$SRC_DIR/scripts/service.sh"
  } > "/usr/local/bin/${SERVICE_NAME}"
  chmod 755 "/usr/local/bin/${SERVICE_NAME}"
  "/usr/local/bin/${SERVICE_NAME}" start >/dev/null 2>&1 || true
  sleep 2
  "/usr/local/bin/${SERVICE_NAME}" status >/dev/null 2>&1 && ok "standalone panel chalu (forge status)" || warn "panel start nahi hua — forge logs"
  mkdir -p /etc/cron.d
  echo "@reboot root /usr/local/bin/${SERVICE_NAME} start >/dev/null 2>&1" > "/etc/cron.d/${SERVICE_NAME}"
  chmod 644 "/etc/cron.d/${SERVICE_NAME}"
  ok "reboot autostart set"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
  ok "ufw port $PORT allowed"
fi

# ------------------------------------------------------------------ 7. check
step "7/7  Health check"
HEALTH=""
for i in $(seq 1 25); do
  HEALTH="$(curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done
[ -n "$HEALTH" ] && ok "panel live: $HEALTH" || warn "health check fail — 'forge logs' dekhein"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
printf "\n${C_B}  Forge ready 🚀${C_0}\n\n"
printf "  ${C_B}Panel   :${C_0} http://%s:%s\n" "${IP:-<server-ip>}" "$PORT"
printf "  ${C_B}Local   :${C_0} http://localhost:%s\n" "$PORT"
printf "  ${C_B}Model   :${C_0} %s\n" "$MODEL"
printf "  ${C_B}Engine  :${C_0} %s\n" "$APP_DIR/data/bin/llama-server"
printf "  ${C_B}Data    :${C_0} %s/data (models, chats, workspace)\n\n" "$APP_DIR"
printf "  ${C_B}Pehla step:${C_0} browser kholo → password set karo → Models → Load → chat!\n"
printf "  ${C_B}Commands :${C_0} forge start | stop | restart | status | logs | port <n>\n\n"
printf "  ${C_DIM}Speed note: GPU nahi hai to 1.5B model ~5-15 tok/s dega (2 vCPU par).\n"
printf "  Bada model = better code par zyada slow. UI me tok/s live dikhta hai.${C_0}\n\n"
