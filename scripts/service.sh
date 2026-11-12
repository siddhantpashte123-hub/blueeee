#!/usr/bin/env bash
# Forge control script (systemd ke bina) — installer isko /usr/local/bin/forge banata hai.
#
#   forge start | stop | restart | status | logs | port <n>

PID_FILE="${PID_FILE:-$APP_DIR/data/panel.pid}"
LOG_FILE="${LOG_FILE:-$APP_DIR/data/panel.log}"
PORT_FILE="${PORT_FILE:-$APP_DIR/data/port}"
LAUNCH="$APP_DIR/data/launch.sh"
DEFAULT_PORT="${DEFAULT_PORT:-4040}"

c_ok="\033[32m"; c_dim="\033[2m"; c_b="\033[1m"; c_0="\033[0m"

panel_pid() {
  [ -f "$PID_FILE" ] || return 1
  local p
  p="$(tr -dc '0-9' < "$PID_FILE" 2>/dev/null)"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  echo "$p"
}

current_port() {
  local p=""
  [ -f "$PORT_FILE" ] && p="$(tr -dc '0-9' < "$PORT_FILE" 2>/dev/null)"
  echo "${p:-$DEFAULT_PORT}"
}

as_user() {
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
  if [ "$(id -u)" = "0" ] && [ -n "${SERVICE_USER:-}" ]; then
    chown "$SERVICE_USER" "$LAUNCH" 2>/dev/null || true
    touch "$LOG_FILE" 2>/dev/null || true
    chown "$SERVICE_USER" "$LOG_FILE" 2>/dev/null || true
  fi
}

cmd_start() {
  local pid port
  if pid="$(panel_pid)"; then
    printf "  ${c_ok}✓${c_0} panel pehle se chal raha hai (pid %s, port %s)\n" "$pid" "$(current_port)"
    return 0
  fi
  port="$(current_port)"
  while ! node -e "const n=require('net');const s=n.createServer();s.once('error',()=>process.exit(1));s.once('listening',()=>s.close(()=>process.exit(0)));s.listen(${port},'0.0.0.0');" 2>/dev/null; do
    printf "  port %s busy — agla try\n" "$port"
    port=$((port+1))
    [ "$port" -gt 65000 ] && { echo "  free port nahi mila"; return 1; }
  done
  echo "$port" > "$PORT_FILE"
  [ "$(id -u)" = "0" ] && chown "${SERVICE_USER:-root}" "$PORT_FILE" 2>/dev/null || true

  rm -f "$PID_FILE"
  write_launcher "$port"
  as_user "nohup setsid '$LAUNCH' >> '$LOG_FILE' 2>&1 < /dev/null &" >/dev/null 2>&1

  local i=0
  while [ $i -lt 40 ]; do
    if pid="$(panel_pid)"; then
      printf "  ${c_ok}✓${c_0} panel start (pid %s) → http://localhost:%s\n" "$pid" "$port"
      return 0
    fi
    sleep 0.4; i=$((i+1))
  done
  echo "  ✗ panel start nahi hua — 'forge logs' dekhein"
  [ -f "$LOG_FILE" ] && tail -n 15 "$LOG_FILE"
  return 1
}

cmd_stop() {
  local pid
  if ! pid="$(panel_pid)"; then
    echo "  panel band hai"
    rm -f "$PID_FILE"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  local i=0
  while [ $i -lt 40 ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25; i=$((i+1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    echo "  force stop kiya"
  else
    printf "  ${c_ok}✓${c_0} panel band (model bhi unload ho gaya)\n"
  fi
  rm -f "$PID_FILE"
}

cmd_status() {
  local pid port
  port="$(current_port)"
  if pid="$(panel_pid)"; then
    printf "  ${c_ok}●${c_0} ${c_b}running${c_0}  pid %s · port %s\n" "$pid" "$port"
    printf "  ${c_dim}http://localhost:%s${c_0}\n" "$port"
    command -v curl >/dev/null && printf "  ${c_dim}%s${c_0}\n" "$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null || echo 'health check fail')"
    return 0
  fi
  printf "  ${c_dim}●${c_0} stopped (port %s)\n" "$port"
  return 1
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || { echo "  log file nahi hai: $LOG_FILE"; return 1; }
  tail -n "${LINES:-60}" "$LOG_FILE"
  [ -t 1 ] && { echo; echo "  (Ctrl+C se bahar — panel chalta rahega)"; tail -f "$LOG_FILE"; }
}

cmd_port() {
  local newp="$1"
  case "$newp" in
    ''|*[!0-9]*) echo "  usage: forge port <number>"; return 1 ;;
  esac
  mkdir -p "$APP_DIR/data"
  echo "$newp" > "$PORT_FILE"
  [ "$(id -u)" = "0" ] && chown "${SERVICE_USER:-root}" "$PORT_FILE" 2>/dev/null || true
  printf "  ${c_ok}✓${c_0} port %s save\n" "$newp"
  if panel_pid >/dev/null; then cmd_stop >/dev/null; cmd_start; fi
}

case "${1:-status}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  port)    shift; cmd_port "${1:-}" ;;
  *)
    echo "  Forge — commands:"
    echo "    forge start      panel + model engine chalu"
    echo "    forge stop       band"
    echo "    forge restart    restart"
    echo "    forge status     chal raha hai?"
    echo "    forge logs       log dekhein"
    echo "    forge port 4041  port badlein"
    ;;
esac
