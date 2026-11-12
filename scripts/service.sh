#!/usr/bin/env bash
#
# BotDeck process control — used on servers without systemd (containers,
# OpenVZ/LXC, minimal images...). Installed as /usr/local/bin/botdeck.
#
#   botdeck start | stop | restart | status | logs
#
set -uo pipefail

APP_DIR="__APP_DIR__"
NODE_BIN="__NODE_BIN__"
PORT="__PORT__"
SERVICE_USER="__SERVICE_USER__"
NAME="__SERVICE_NAME__"

PID_FILE="${APP_DIR}/data/panel.pid"
LOG_FILE="${APP_DIR}/data/panel.log"

# When called as root, drop to the service user so panel files stay owned by it.
if [ "$(id -u)" -eq 0 ] && [ "$SERVICE_USER" != "root" ] && [ "$(id -un)" != "$SERVICE_USER" ]; then
  if command -v su >/dev/null 2>&1; then
    exec su -s /bin/bash "$SERVICE_USER" -c "\"$0\" ${1:-status}"
  fi
  echo "warning: 'su' not found — running the panel as root" >&2
fi

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  if is_running; then
    echo "BotDeck is already running (pid $(cat "$PID_FILE")) on port ${PORT}"
    return 0
  fi
  mkdir -p "$APP_DIR/data" "$APP_DIR/bots"
  cd "$APP_DIR" || return 1

  nohup env NODE_ENV=production PORT="$PORT" HOST=0.0.0.0 \
    DATA_DIR="$APP_DIR/data" BOTS_DIR="$APP_DIR/bots" \
    "$NODE_BIN" "$APP_DIR/server.js" >> "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
  sleep 2

  if is_running; then
    echo "BotDeck started on port ${PORT} (pid $(cat "$PID_FILE"))"
    return 0
  fi
  echo "BotDeck failed to start. Last log lines:"
  tail -n 20 "$LOG_FILE" 2>/dev/null
  rm -f "$PID_FILE"
  return 1
}

cmd_stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "BotDeck is not running"
    return 0
  fi
  local pid i
  pid="$(cat "$PID_FILE")"
  kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 30); do
    is_running || break
    sleep 1
  done
  if is_running; then
    echo "Panel did not stop within 30s — sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null
    sleep 1
  fi
  rm -f "$PID_FILE"
  echo "BotDeck stopped"
}

case "${1:-status}" in
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    cmd_stop
    sleep 1
    cmd_start
    ;;
  status)
    if is_running; then
      echo "running (pid $(cat "$PID_FILE")) on port ${PORT}"
    else
      echo "stopped"
      exit 3
    fi
    ;;
  logs)
    tail -n 100 -f "$LOG_FILE"
    ;;
  *)
    echo "usage: ${NAME} {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
