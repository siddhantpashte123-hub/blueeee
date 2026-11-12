'use strict';

const NODE_TEMPLATE = (name) => `// ${name} — starter bot created by BotDeck
// Edit this file from the panel: Bot -> Files -> ${'index.js'}

console.log('[bot] starting…');

let ticks = 0;
setInterval(() => {
  ticks++;
  console.log(\`[bot] alive — tick \${ticks} — \${new Date().toISOString()}\`);
}, 5000);

// BotDeck stops bots with SIGTERM first — shut down cleanly.
process.on('SIGTERM', () => {
  console.log('[bot] SIGTERM received, shutting down');
  process.exit(0);
});
`;

const PY_TEMPLATE = (name) => `# ${name} — starter bot created by BotDeck
import datetime
import signal
import sys
import time

print("[bot] starting…", flush=True)

def _shutdown(*_args):
    print("[bot] shutting down", flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, _shutdown)

ticks = 0
while True:
    ticks += 1
    print(f"[bot] alive — tick {ticks} — {datetime.datetime.now().isoformat(timespec='seconds')}", flush=True)
    time.sleep(5)
`;

const BASH_TEMPLATE = (name) => `#!/usr/bin/env bash
# ${name} — starter bot created by BotDeck
set -uo pipefail

echo "[bot] starting…"
trap 'echo "[bot] shutting down"; exit 0' TERM INT

while true; do
  echo "[bot] alive — $(date -Is)"
  sleep 5
done
`;

const CUSTOM_TEMPLATE = (name) => `#!/usr/bin/env bash
# ${name} — custom bot created by BotDeck
# This whole script runs as-is through /bin/sh.
# Use it for anything: java -jar app.jar, ./binary, npm start, ...

echo "[bot] starting…"
while true; do
  echo "[bot] alive — $(date -Is)"
  sleep 10
done
`;

const TEMPLATES = {
  node: { file: 'index.js', body: NODE_TEMPLATE, mode: 0o644 },
  python: { file: 'main.py', body: PY_TEMPLATE, mode: 0o644 },
  bash: { file: 'start.sh', body: BASH_TEMPLATE, mode: 0o755 },
  custom: { file: 'start.sh', body: CUSTOM_TEMPLATE, mode: 0o755 }
};

module.exports = { TEMPLATES };
