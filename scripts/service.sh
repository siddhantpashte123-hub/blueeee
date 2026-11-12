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
PORT_FILE="${APP_DIR}/data/port"

# A port chosen with `botdeck port <n>` wins over the one baked in at install.
if [ -f "$PORT_FILE" ]; then
  SAVED_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
  case "$SAVED_PORT" in
    ''|*[!0-9]*) ;;
    *) PORT="$SAVED_PORT" ;;
  esac
fi

port_free() {
  local p="$1"
  "$NODE_BIN" -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.once("listening", () => server.close(() => process.exit(0)));
    server.listen(port, "0.0.0.0");
  ' "$p" >/dev/null 2>&1
}

# When called as root, drop to the service user so panel files stay owned by it.
if [ "$(id -u)" -eq 0 ] && [ "$SERVICE_USER" != "root" ] && [ "$(id -un)" != "$SERVICE_USER" ]; then
  if command -v su >/dev/null 2>&1; then
    if [ "$#" -eq 0 ]; then set -- status; fi
    REEXEC="$(printf '%q ' "$0" "$@")"
    exec su -s /bin/bash "$SERVICE_USER" -c "$REEXEC"
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

  if ! port_free "$PORT"; then
    echo "Port ${PORT} is already in use by another program."
    echo "Pick another port, for example:  $(basename "$0") port $((PORT + 1))"
    echo "Then:                            $(basename "$0") restart"
    return 1
  fi

  cd "$APP_DIR" || return 1

  export NODE_ENV=production
  export PORT
  export HOST=0.0.0.0
  export DATA_DIR="$APP_DIR/data"
  export BOTS_DIR="$APP_DIR/bots"

  rm -f "$PID_FILE"
  # `setsid` gives the panel its own session, so Ctrl+C / closing the terminal /
  # ending this su session cannot kill it. The child writes its own pid so the
  # pid file is correct even if setsid forks.
  local launcher=""
  if command -v setsid >/dev/null 2>&1; then
    launcher="setsid"
  fi

  nohup $launcher bash -c 'echo $$ > "$0"; exec "$1" "$2"' \
    "$PID_FILE" "$NODE_BIN" "$APP_DIR/server.js" >> "$LOG_FILE" 2>&1 < /dev/null &
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
  port)
    case "${2:-}" in
      ''|*[!0-9]*)
        echo "usage: ${NAME} port <1-65535>"
        exit 1
        ;;
    esac
    if [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then
      echo "Port must be between 1 and 65535"
      exit 1
    fi
    mkdir -p "$APP_DIR/data"
    echo "$2" > "$PORT_FILE"
    PORT="$2"
    echo "Port set to $2"
    if is_running; then
      echo "Restarting BotDeck on the new port…"
      cmd_stop
      sleep 1
      cmd_start
    else
      echo "Start it with: ${NAME} start"
    fi
    ;;
  *)
    echo "usage: ${NAME} {start|stop|restart|status|logs|port <n>}"
    exit 1
    ;;
esac
