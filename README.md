# BotDeck

**Docker-free bot hosting panel for any VPS.**  
Run unlimited bots as plain Linux processes — no Docker, no containers, no Kubernetes, no npm dependencies.

BotDeck is a single Node.js app with a web UI that lets you create, start, stop, restart and monitor as many bots as your VPS can hold. Each bot gets its own folder, environment variables, live console, log file, file manager, resource stats, crash auto-restart and an optional memory limit.

```
One Node.js process  →  supervises N bot processes  →  manageable from one panel
```

---

## Hinglish quick start (2 minute)

Aapke VPS pe Docker support nahi hai? Koi problem nahi — BotDeck bina Docker ke chalta hai. Har bot ek normal Linux process hota hai, panel usko start/stop/restart karta hai aur logs/console/files sab web UI se manage hote hain.

```bash
# 1. VPS pe repo clone karo (ya files upload karo)
git clone <your-repo-url> botdeck
cd botdeck

# 2. Installer chalao (Node.js bhi khud install kar lega)
sudo bash scripts/install.sh

# 3. Browser me kholo → password banao → "New bot" → done
http://YOUR_SERVER_IP:3000
```

Har bot ka apna folder hota hai: `/opt/botdeck/bots/<bot-id>/`.  
Node.js, Python, Bash aur custom shell command — sab runtimes supported hain.

---

## Features

| | |
|---|---|
| **No Docker** | Bots are supervised child processes with their own process group. Nothing else to install. |
| **Unlimited bots** | Create as many as your RAM/CPU allows. Bulk start/stop, search, per-bot stats, one-click cloning of an existing bot (files + config). |
| **Live console** | Server-Sent Events stream of stdout/stderr with ANSI colours, plus stdin input box. |
| **Log files** | Every bot writes to `data/logs/<id>.log` (auto-rotated at 4 MB). Download or clear from the UI. |
| **File manager** | Browse, upload (drag & drop), edit code in the browser, rename, delete, download, extract `.zip` / `.tar.gz`. |
| **Process control** | Start, stop (SIGTERM → SIGKILL after 8s), restart, force kill. Whole process tree is cleaned up. |
| **Crash recovery** | Auto-restart with exponential backoff (1s → 15s) and a max-attempt limit. |
| **Memory guard** | Optional per-bot memory limit. Bot is stopped and flagged if it exceeds it — a lightweight `docker --memory` replacement. |
| **Autostart** | Bots marked "start with panel" come back automatically after a server reboot. |
| **Real metrics** | Per-bot CPU %, RSS memory and process count read from `/proc`, plus host CPU/RAM/disk/load. |
| **Single admin** | Password auth (scrypt), session tokens, login rate limiting, CSRF-safe API. |
| **Zero dependencies** | `package.json` has no npm packages. `git pull` + restart is the whole update process. |

---

## Requirements

- Linux VPS (systemd **or** no systemd — both work)
- Node.js **18 or newer** (installer handles it)
- ~100 MB RAM for the panel itself; plus whatever your bots use
- Optional: `python3` for Python bots, `unzip`/`tar` for archive extraction

Works fine on a 1 vCPU / 1 GB RAM box for a handful of light bots.

---

## Install

### One command

```bash
curl -fsSL https://raw.githubusercontent.com/siddhantpashte123-hub/blueeee/arena/ac969ea0-blueeee/scripts/install.sh | sudo bash
```

This downloads the latest source, installs Node.js if needed, creates the
`botdeck` service user, copies the panel to `/opt/botdeck`, sets up startup
(systemd service, or a `botdeck` control script + cron when systemd is missing)
and starts it. Then open `http://YOUR_SERVER_IP:3000`.

> Once this branch is merged into `main`, you can use the shorter `.../main/...` URL.

### From a clone

```bash
git clone https://github.com/siddhantpashte123-hub/blueeee botdeck
cd botdeck
sudo bash scripts/install.sh
```

The installer:

1. installs Node.js 18+ if missing (NodeSource → distro package fallback),
2. creates a dedicated `botdeck` system user,
3. copies the panel to `/opt/botdeck`,
4. installs and starts a **systemd** service named `botdeck` — or, on hosts
   without systemd, the `botdeck` control script plus a cron autostart entry,
5. opens the port in `ufw` if the firewall is active.

Options:

```bash
sudo APP_DIR=/srv/botdeck PORT=8080 SERVICE_USER=bots bash scripts/install.sh
sudo NO_SYSTEMD=1 bash scripts/install.sh   # force the no-systemd standalone mode
```

Then open `http://YOUR_SERVER_IP:3000` and create the admin password on first visit.

### Servers without systemd (containers, OpenVZ/LXC, minimal images)

Many cheap VPS hosts ship **no systemd** at all (`systemctl: command not found`).
The installer detects that automatically and installs a small control script
instead of the unit — nothing manual needed:

```bash
botdeck status      # running? which pid/port
botdeck start
botdeck restart
botdeck stop
botdeck logs        # tail -f /opt/botdeck/data/panel.log
```

In this mode:

- panel log: `/opt/botdeck/data/panel.log`
- autostart: cron `@reboot` entry in `/etc/cron.d/botdeck` (when cron exists)
- neither systemd nor cron? Start the panel after a reboot with `botdeck start`

### Manual (foreground)

```bash
cd botdeck
PORT=3000 node server.js
```

Or with a process manager you already trust:

```bash
nohup node server.js > panel.log 2>&1 &
```

Keep it alive across reboots with `systemd`, `tmux`, or `screen` — BotDeck does not require any of them.

### Docker? Not needed, but it also runs in one

```bash
docker run -d -p 3000:3000 -v botdeck-data:/app/data -v botdeck-bots:/app/bots node:22 \
  sh -c "cd /app && node server.js"
```

---

## Using the panel

### Create a bot

1. Click **New bot**.
2. Pick a name and a runtime:
   - **Node.js** → `node index.js`
   - **Python 3** → `python3 -u main.py`
   - **Bash script** → `bash start.sh`
   - **Custom command** → anything, e.g. `java -jar server.jar` or `./my-binary --port 8080`
3. BotDeck creates the folder and a starter file. Start it, then edit files in the **Files** tab.

### Bot settings

| Setting | Meaning |
|---|---|
| **Entry file / command** | File run inside the bot folder, or a full shell command for the *custom* runtime. |
| **Arguments** | Extra CLI arguments, e.g. `--shard 1 --token abc`. |
| **Port** | Optional. Injected as `PORT` env var and shown as a clickable link in the header. |
| **Memory limit** | `0` = unlimited. Checked every 5 seconds; bot is stopped when exceeded. |
| **Auto-restart** | Restart automatically after a crash (exit code ≠ 0 / signal). |
| **Max restart attempts** | Stops trying after N failures. Counter resets after 60 s of healthy uptime. |
| **Start with panel** | Add to autostart after server/panel reboot. |
| **Environment variables** | Passed directly to the process (`process.env` / `os.environ`). |

Python bots get `PYTHONUNBUFFERED=1` automatically so logs appear instantly.
`HOME`, `PWD`, `BOT_ID`, `BOT_NAME` and `BOT_DIR` are always set for the bot.

### Files

Everything in a bot folder is editable from the **Files** tab:

- drag & drop to upload (any file type, up to 256 MB per file),
- click a file to edit it in the code editor (`Ctrl`/`Cmd` + `S` saves),
- extract `.zip` / `.tar` / `.tar.gz` / `.tgz` in place,
- rename, download, delete.

### Console

The console streams live output and lets you write to the bot's stdin
(useful for REPL-style bots). It reconnects automatically if the connection drops.
Logs survive panel restarts; rotate at 4 MB.

---

## How it works

```
┌─────────────────────────────┐
│  BotDeck panel (Node.js)    │  HTTP + SSE on :3000
│  store: data/panel.json     │
└──────────────┬──────────────┘
               │ spawn() / SIGTERM / SIGKILL (process group)
     ┌─────────┼──────────┬──────────────┐
   bot A     bot B      bot C          bot N
  bots/<id>/  own cwd, HOME, env, log
```

- Each bot is spawned with `detached: true`, giving it its own process group.
  Stop/kill signals go to `-pid`, so child processes (shell wrappers, spawned
  workers) are terminated too.
- Bots run in `bots/<id>/`, which is also their `HOME`.
- The panel keeps at most 600 log lines in memory per bot for the live console;
  the full log file is always on disk.
- Panel crashes cannot leave zombies for long: on boot, `data/runtime.json` is
  used to kill leftover processes whose working directory belongs to a bot.
- On `SIGTERM`/`SIGINT` the panel stops all bots cleanly before exiting, which is
  what happens on `systemctl restart botdeck`.

### Files & folders

```
/opt/botdeck
├── server.js            # entry point
├── src/                 # backend modules
├── public/              # web UI (no build step)
├── data/
│   ├── panel.json       # settings, bot configs, password hash
│   ├── runtime.json     # pids of running bots (crash cleanup)
│   └── logs/<bot>.log   # bot logs
└── bots/<bot-id>/       # each bot's files (cwd + HOME)
```

Backup = copy `data/panel.json`, `data/logs/` and `bots/`. Nothing else is state.

---

## Security

BotDeck is an admin panel: anyone who can log in can run arbitrary code as the
service user. Treat it like SSH.

- The installer runs the panel as the unprivileged `botdeck` user, **not root**.
- Passwords are hashed with scrypt; sessions are random 32-byte tokens stored
  in memory, sent as `HttpOnly` cookies and/or `Authorization: Bearer` headers.
- Login attempts are rate limited (10 per IP per 5 minutes).
- All file operations are sandboxed to the bot's folder (`..` and absolute paths
  are rejected server-side).
- Bots inherit the panel user's permissions — do not run the panel as root.

**Put it behind HTTPS** — a domain + Caddy is the easiest:

```caddyfile
panel.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Nginx equivalent (SSE needs buffering off):

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    # ssl_certificate ...;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # required for the live console
        proxy_read_timeout 3600s;     # keep SSE connections open
    }
}
```

When using a reverse proxy, bind the panel to localhost only:

```bash
# /etc/systemd/system/botdeck.service
Environment=HOST=127.0.0.1
```

---

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Panel database + logs |
| `BOTS_DIR` | `./bots` | Bot folders |
| `BOTDECK_PASSWORD` | – | Set the admin password on first start (min 8 chars), handy for automated installs |
| `PYTHON` | `python3` | Python interpreter used for Python bots |

Panel name can be changed in **Panel settings** (stored in `data/panel.json`).

### Service commands

With systemd:

```bash
systemctl status botdeck
systemctl restart botdeck      # graceful: stops bots first, autostart bots come back
journalctl -u botdeck -f       # panel logs
journalctl -u botdeck -n 100 --no-pager
```

Without systemd:

```bash
botdeck status
botdeck restart                # graceful, same behaviour
botdeck logs                   # tail -f /opt/botdeck/data/panel.log
```

---

## HTTP API

All endpoints are JSON and require the session (cookie or `Authorization: Bearer <token>`).

<details>
<summary><b>Auth</b></summary>

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/status` | setup required? panel name |
| `POST` | `/api/auth/setup` | `{password}` first-run |
| `POST` | `/api/auth/login` | `{password}` → `{token}` |
| `POST` | `/api/auth/logout` | destroy session |
| `POST` | `/api/auth/password` | `{current, next}` |

</details>

<details>
<summary><b>Bots</b></summary>

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/overview` | bots + system stats |
| `GET` | `/api/bots` | list bots |
| `POST` | `/api/bots` | `{name, runtime, start?, autostart?}` create |
| `GET` | `/api/bots/:id` | one bot |
| `PATCH` | `/api/bots/:id` | update config / env |
| `DELETE` | `/api/bots/:id?files=1` | delete bot (optionally its folder) |
| `POST` | `/api/bots/:id/start\|stop\|restart\|kill` | process control |
| `POST` | `/api/bots/:id/clone` | `{name}` duplicate bot + files |
| `POST` | `/api/bots/actions` | `{action:"start-all"\|"stop-all"\|"restart-all"}` |
| `POST` | `/api/bots/:id/input` | `{data}` write to stdin |
| `GET` | `/api/bots/:id/logs?lines=300` | log tail |
| `GET` | `/api/bots/:id/logs/download` | download log file |
| `DELETE` | `/api/bots/:id/logs` | clear log |
| `GET` | `/api/bots/:id/stream?token=…` | SSE: `log` + `status` events |

</details>

<details>
<summary><b>Files</b></summary>

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/bots/:id/files?path=` | list folder |
| `GET` | `/api/bots/:id/files/read?path=` | read text file |
| `PUT` | `/api/bots/:id/files/write?path=` | `{content}` save text file |
| `PUT` | `/api/bots/:id/files/upload?path=&name=` | raw binary upload |
| `GET` | `/api/bots/:id/files/download?path=` | download file |
| `POST` | `/api/bots/:id/files/mkdir` | `{path}` |
| `POST` | `/api/bots/:id/files/rename` | `{from, to}` |
| `POST` | `/api/bots/:id/files/delete` | `{path}` |
| `POST` | `/api/bots/:id/files/extract` | `{path}` unzip / untar |

</details>

Example:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"your-password"}' | jq -r .token)

curl -s -X POST localhost:3000/api/bots \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"My Bot","runtime":"node","start":true}' | jq

curl -sN "localhost:3000/api/bots/<id>/stream?token=$TOKEN"   # live console
```

---

## Updating

```bash
# installed with the one-liner:
curl -fsSL https://raw.githubusercontent.com/siddhantpashte123-hub/blueeee/arena/ac969ea0-blueeee/scripts/install.sh | sudo bash

# installed from a clone:
cd botdeck && git pull && sudo bash scripts/install.sh
```

`data/` and `bots/` are never touched by the installer. Bots with
"start with panel" enabled come back automatically.

## Uninstall

```bash
sudo bash scripts/uninstall.sh            # removes the service, keeps data
sudo bash scripts/uninstall.sh --purge    # also deletes /opt/botdeck
```

---

## Troubleshooting

**Port already in use**  
`PORT=3001 node server.js`, or change `Environment=PORT=` in the systemd unit.

**Bot exits immediately**  
Open the bot's **Console** and read the error. Common causes: wrong entry file,
missing `npm install` inside the bot folder, missing interpreter
(`python3: not found`), or a syntax error. The console shows the exact reason.

**"Entry file was not found"**  
Upload your bot files first (Files → Upload) or fix the entry path in settings.

**Bot won't stop**  
Use **Force kill** (SIGKILL). On the settings tab it's under *Danger zone*.

**Live console not updating behind Nginx**  
Set `proxy_buffering off;` and raise `proxy_read_timeout` for the location.

**The installer still says "Creating systemd service" (old version)**  
`raw.githubusercontent.com` caches for a few minutes. Use the commit-pinned URL
from the releases section / add a cache buster: `...install.sh?cb=$(date +%s)`.
The installer prints its version in the banner (`installer v2.1`), so you can
tell immediately whether you got the current script.

**`systemctl: command not found` during install**  
That host has no systemd. The current installer detects this and switches to
standalone mode automatically (`botdeck` control script + cron autostart) —
just re-run the install command.

**`botdeck: command not found` (standalone install)**  
The script is `/usr/local/bin/botdeck`; check that `/usr/local/bin` is in `PATH`.

**Everything is unreachable**  
`systemctl status botdeck`, then `journalctl -u botdeck -n 100 --no-pager`.
Check the cloud provider firewall allows your port.

**Python bots show no output**  
BotDeck already passes `PYTHONUNBUFFERED=1`; if your script buffers on its own,
call `print(..., flush=True)` or run Python with `-u`.

---

## Development

```bash
node server.js          # http://localhost:3000, auto-creates data/ and bots/
npm run dev             # same, with --watch for backend reloads
node --check public/assets/app.js
```

Dev UI smoke test (needs `npm i --no-save jsdom` and a running panel):

```bash
node tests/ui-smoke.js
```

The frontend is plain HTML/CSS/JS — no bundler, no framework, no build step.
Edit `public/` and refresh.

## License

MIT
