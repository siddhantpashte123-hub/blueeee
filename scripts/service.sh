#!/usr/bin/env bash
# VPSDeck control script (systemd ke bina chalne wale hosts ke liye)
# Installer isko /usr/local/bin/vpsdeck par likhta hai aur upar variables bhi.
#
#   vpsdeck start | stop | restart | status | logs | port <n>
#
# Zaroori: start hone ke baad panel apni alag session me chalta hai,
# isliye Ctrl+C ya SSH band karne se panel/VMs nahi rukte.

PID_FILE="${PID_FILE:-$APP_DIR/data/panel.pid}"
LOG_FILE="${LOG_FILE:-$APP_DIR/data/panel.log}"
PORT_FILE="${PORT_FILE:-$APP_DIR/data/port}"
LAUNCH="$APP_DIR/data/launch.sh"
DEFAULT_PORT="${DEFAULT_PORT:-8080}"

c_ok="\033[32m"; c_dim="\033[2m"; c_b="\033[1m"; c_0="\033[0m"

panel_pid() {
  [ -f "$PID_FILE" ] || return 1
  local p
  p="$(cat "$PID_FILE" 2>/dev/null | tr -dc '0-9')"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  echo "$p"
}

current_port() {
  local p=""
  [ -f "$PORT_FILE" ] && p="$(cat "$PORT_FILE" 2>/dev/null | tr -dc '0-9')"
  echo "${p:-$DEFAULT_PORT}"
}

as_user() {
  # $1 = command string
  if [ "$(id -u)" = "0" ] && [ -n "${SERVICE_USER:-}" ] && [ "$SERVICE_USER" != "root" ]; then
    su -s /bin/bash "$SERVICE_USER" -c "$1"
  else
    bash -c "$1"
  fi
}

write_launcher() {
  local port="$1"
  mkdir -p "$APP_DIR/data"
  cat > "$LAUNCH" <<EOF
#!/usr/bin/env bash
cd "$APP_DIR" || exit 1
export APP_DIR="$APP_DIR"
export PORT="$port"
export NODE_ENV=production
echo \$\$ > "$PID_FILE"
exec "$NODE_BIN" "$APP_DIR/server.js"
EOF
  chmod 755 "$LAUNCH"
  if [ "$(id -u)" = "0" ] && [ -n "${SERVICE_USER:-}" ] && [ "$SERVICE_USER" != "root" ]; then
    chown "$SERVICE_USER" "$LAUNCH" 2>/dev/null || true
    touch "$LOG_FILE" 2>/dev/null || true
    chown "$SERVICE_USER" "$LOG_FILE" 2>/dev/null || true
  fi
}

cmd_start() {
  local pid
  if pid="$(panel_pid)"; then
    printf "  ${c_ok}✓${c_0} panel pehle se chal raha hai (pid %s, port %s)\n" "$pid" "$(current_port)"
    return 0
  fi
  local port
  port="$(current_port)"
  while ! node -e "const n=require('net');const s=n.createServer();s.once('error',()=>process.exit(1));s.once('listening',()=>s.close(()=>process.exit(0)));s.listen(${port},'0.0.0.0');" 2>/dev/null; do
    printf "  port %s busy hai — agla try kar raha hoon\n" "$port"
    port=$((port + 1))
    [ "$port" -gt 65000 ] && { echo "  koi free port nahi mila"; return 1; }
  done
  echo "$port" > "$PORT_FILE"
  [ "$(id -u)" = "0" ] && chown "${SERVICE_USER:-root}" "$PORT_FILE" 2>/dev/null || true

  rm -f "$PID_FILE"
  write_launcher "$port"
  # setsid => apni session, terminal band hone par bhi zinda
  as_user "nohup setsid '$LAUNCH' >> '$LOG_FILE' 2>&1 < /dev/null &" >/dev/null 2>&1

  local i=0
  while [ $i -lt 40 ]; do
    if pid="$(panel_pid)"; then
      printf "  ${c_ok}✓${c_0} panel start ho gaya (pid %s)\n" "$pid"
      printf "  ${c_dim}http://localhost:%s${c_0}\n" "$port"
      return 0
    fi
    sleep 0.4
    i=$((i + 1))
  done
  echo "  ✗ panel start nahi hua — log dekhein: vpsdeck logs"
  [ -f "$LOG_FILE" ] && tail -n 15 "$LOG_FILE"
  return 1
}

cmd_stop() {
  local pid
  if ! pid="$(panel_pid)"; then
    echo "  panel band hai (kuch karne ki zaroorat nahi)"
    rm -f "$PID_FILE"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  local i=0
  while [ $i -lt 40 ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    echo "  panel ko force stop kiya"
  else
    printf "  ${c_ok}✓${c_0} panel band ho gaya (VMs chalte rahenge)\n"
  fi
  rm -f "$PID_FILE"
}

cmd_status() {
  local pid port
  port="$(current_port)"
  if pid="$(panel_pid)"; then
    printf "  ${c_ok}●${c_0} ${c_b}running${c_0}  pid %s · port %s\n" "$pid" "$port"
    printf "  ${c_dim}http://localhost:%s${c_0}\n" "$port"
    if command -v curl >/dev/null; then
      local h
      h="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
      [ -n "$h" ] && printf "  ${c_dim}health: %s${c_0}\n" "$h"
    fi
    return 0
  fi
  printf "  ${c_dim}●${c_0} stopped (port %s)\n" "$port"
  return 1
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || { echo "  log file abhi nahi hai: $LOG_FILE"; return 1; }
  tail -n "${LINES:-60}" "$LOG_FILE"
  [ -t 1 ] && { echo; echo "  (Ctrl+C dabayein — panel nahi rukega)"; tail -f "$LOG_FILE"; }
}

cmd_port() {
  local newp="$1"
  case "$newp" in
    ''|*[!0-9]*) echo "  usage: vpsdeck port <number>  (jaise: vpsdeck port 9090)"; return 1 ;;
  esac
  if [ "$newp" -lt 1 ] || [ "$newp" -gt 65535 ]; then
    echo "  port 1-65535 ke beech hona chahiye"; return 1
  fi
  mkdir -p "$APP_DIR/data"
  echo "$newp" > "$PORT_FILE"
  [ "$(id -u)" = "0" ] && chown "${SERVICE_USER:-root}" "$PORT_FILE" 2>/dev/null || true
  printf "  ${c_ok}✓${c_0} port %s save ho gaya\n" "$newp"
  if panel_pid >/dev/null; then
    cmd_stop >/dev/null
    DEFAULT_PORT="$newp" cmd_start
  fi
}

case "${1:-status}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  port)    shift; cmd_port "${1:-}" ;;
  *)
    echo "  VPSDeck — commands:"
    echo "    vpsdeck start       panel chalu karein"
    echo "    vpsdeck stop        panel band karein (VMs chalte rahenge)"
    echo "    vpsdeck restart     restart"
    echo "    vpsdeck status      chal raha hai ya nahi"
    echo "    vpsdeck logs        panel log dekhein"
    echo "    vpsdeck port 9090   panel ka port badlein"
    ;;
esac
