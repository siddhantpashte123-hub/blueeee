# Forge ⚡

**Aapke apne VPS par chalta AI code studio.** Koi API key nahi, koi cloud nahi, koi bill nahi — model aapke server par, chat aapke browser me, code aapke folder me.

Port **4040** par chalta hai. `llama.cpp` engine + aapka chuna hua chhota model (1–5 GB). Docker, GPU ya systemd ki zaroorat nahi.

```
┌──────────── browser :4040 ────────────┐
│  chats   │   chat + streaming   │ files│
└──────────┴──────────┬───────────┴──────┘
                      │  SSE
              ┌───────▼────────┐
              │  Forge (Node)  │  ← ye panel
              └───────┬────────┘
                      │ 127.0.0.1:4055
              ┌───────▼──────────────┐
              │ llama-server + GGUF  │  ← aapka model (CPU par)
              └──────────────────────┘
```

---

## Pehle sach (important)

Ye **ChatGPT jaisa** nahi hai. Ye ek **chhota local model** hai jo CPU par chalta hai:

| Aapke VPS | Model | Speed | Kya kar sakta hai |
|---|---|---|---|
| 2 vCPU / 4 GB | Qwen2.5-Coder **1.5B** | ~5–12 tok/s | Chhote files, functions, HTML/CSS, scripts, bug fix |
| 4 vCPU / 8 GB | Qwen2.5-Coder **3B** | ~4–9 tok/s | Poora chhota project (3–5 files), API endpoints |
| 8 vCPU / 16 GB | Qwen2.5-Coder **7B** | ~2–5 tok/s | Behtar reasoning, bade files, refactor |

Matlab:
- ✅ Single-file web apps, landing pages, scripts, CRUD API, regex, SQL, config, tests — **achha karta hai**
- ✅ Aapke project ke files padh ke usi style me code likh sakta hai (context)
- ⚠️ Bade multi-file production apps, ya complex architecture — adhoora/ghalat ho sakta hai, review karna zaroori
- ❌ Bahut lambi files (1000+ lines) ek baar me nahi likhta — chhote chunks me kaam karwao

Ek 1.5B model 10 GB model jaisa smart nahi hota — par **free, private aur unlimited** hai. Isi liye Forge me har code block par **Apply** button hai: AI likhta hai, aap dekh ke apply karte ho. Blind copy nahi.

---

## Features

**Chat**
- Token-by-token streaming (SSE), Stop button, tok/s live
- 5 system presets: ⚡ Senior Engineer, 🏗️ Architect, 🐞 Debugger, 🔎 Reviewer, 🎨 UI Designer
- Chat history server par save (data/chats), rename / delete
- Project files context me attach kar sakte ho (📎) — model aapka code dekh ke likhta hai

**Code**
- AI file fences `path=...` ke saath deta hai → **Apply** button se seedha workspace me
- Multi-file apply, auto-apply (Settings me on karo to sab automatic)
- Built-in editor (save, delete, tab-indent), file tree, ZIP download
- **Live preview**: HTML/CSS/JS projects ka render, iframe sandbox me (safe)

**Engine**
- Model manager: download (progress ke saath), load/unload, delete, custom GGUF URL
- RAM dekh ke model recommend karta hai
- Engine logs UI me (agar model load fail ho to wajah dikhti hai)
- External engine support: pehle se `llama.cpp`/`Ollama` chal raha ho to `LLM_URL` se jod do

**Panel**
- Password login (scrypt + session cookie), login rate-limit, CSRF origin check
- Path traversal safe file API, 512 KB per file limit
- Zero npm dependencies, ek Node process

---

## Install (1 command)

```bash
curl -fsSL https://raw.githubusercontent.com/siddhantpashte123-hub/blueeee/main/scripts/install.sh | sudo bash
```

Kya karta hai:
1. Node 18+ (nahi hai to install)
2. `forge` system user
3. **llama.cpp** ka official prebuilt binary (GitHub release, ~25 MB) — compile ki zaroorat nahi
4. Aapki RAM ke hisaab se model download (1.5B default ~1 GB)
5. Panel `/opt/forge` me, port **4040** (busy ho to agla free)
6. systemd service **ya** standalone `forge` command + reboot autostart
7. Health check + summary

Options:

```bash
# model chuno
curl -fsSL .../install.sh | sudo MODEL=qwen2.5-coder-3b bash
# model/engine skip karo (panel se baad me)
... | sudo SKIP_MODEL=1 bash
# systemd-less VPS
sudo NO_SYSTEMD=1 bash scripts/install.sh
# specific version
sudo FORGE_REF=<commit-sha> bash scripts/install.sh
```

Manual:

```bash
git clone <repo> forge && cd forge
PORT=4040 node server.js       # engine models page se manage karo
# ya apna engine:
LLM_URL=http://127.0.0.1:8080 PORT=4040 node server.js
```

---

## Pehle 5 minute

1. `http://<vps-ip>:4040` kholein (direct nahi khul raha to neeche tunnel dekhein)
2. **Password set karein** (pehli baar)
3. Top-right **Models** → jo model install hai us par **Load** (10–60 s)
4. Chat me likhein: *"ek premium login page banao glassmorphism ke saath"*
5. Code block par **Apply** → file workspace me aa jayegi → **Preview** tab me result dekhein

---

## Code kaise apply hota hai

Model ko system prompt me sikhaya jaata hai ki file is format me de:

````
```html path=index.html
<!doctype html> … poora code …
```
````

Forge isse pakadta hai:
- har code block ke header me **path** badge + **Apply** / **Copy**
- `Apply` → `POST /api/files/apply` → file `data/workspace/` me likhi jaati hai
- `.html` file apply hui to **Preview** khud khul jaata hai
- Settings → **Auto-apply** on karne par sab files khud likh jaati hain (fast loop, par dhyan se)

Workspace hi aapka project hai — `data/workspace/`. Chaho to seedha wahan apna code daal do, phir AI usi par kaam karega (📎 attach / context).

---

## Doston ko dena / internet par lana

**Pinggy (free, testing):**

```bash
ssh -p 443 -R0:localhost:4040 a.pinggy.io
```

**Cloudflare Tunnel (permanent):**

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cloudflared tunnel --url http://localhost:4040
```

Domain + HTTPS ke liye Nginx/Caddy. Streaming ke liye `proxy_buffering off;` zaroori hai:

```nginx
location / {
    proxy_pass http://127.0.0.1:4040;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;      # warna tokens ruk-ruk ke aayenge
    proxy_read_timeout 3600s;
}
```

⚠️ Public URL = duniya bhi khol sakti hai. Strong password rakho, aur model par koi limit nahi hai — koi bhi token generate kar sakta hai.

---

## Commands

```bash
forge start      # panel + engine
forge stop       # dono band
forge restart
forge status     # pid, port, health
forge logs       # live log
forge port 4041  # port badlo
```

systemd mode: `systemctl status|restart forge`

Panel band karne se engine bhi band ho jata hai (RAM free).

---

## Data layout

```
/opt/forge/
├── server.js, src/, public/       # code
└── data/
    ├── panel.json                 # settings, password hash, model list
    ├── bin/llama.cpp/             # engine binary + libs
    ├── bin/llama-server           # wrapper (LD_LIBRARY_PATH)
    ├── models/*.gguf              # model files
    ├── chats/<id>.json            # conversations
    └── workspace/                 # aapka project (AI yahan likhta hai)
```

Backup = `data/` folder copy. Reinstall karne par `data/` nahi udta.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `llama-server nahi mila` | `sudo bash scripts/install.sh` dobara (engine download step), ya `LLM_BIN=/path/to/llama-server` |
| Model load hote hi band ho jata hai | Model RAM me fit nahi. Chhota model (1.5B/0.5B) lo, ya VM ki RAM badhao |
| Chat me "Model load nahi hai" | Panel boot par khud model load karta hai. Fir bhi dikhe to chat me aaye **Model load karo aur bhejo** button dabao — ek click me load + message dobara chala jayega. RAM kam ho to wahi card **1.5B download karo** bhi offer karta hai |
| "Ye model ~X GB RAM maangta hai" | VPS ki asli RAM (cgroup limit) kam hai. Card se recommended chhota model download karo — panel bada model load hone hi nahi dega (panel safe rahega) |
| Load 180s me nahi hua | 7B CPU par slow hai — 1.5B try karo, ya `CTX_SIZE=2048` |
| Bahut slow (1-2 tok/s) | CPU weak hai. Alpine/1.5B model, `THREADS=<cores>` check karo |
| `Illegal instruction (core dumped)` | Binary AVX2 maang raha hai. Purane CPU par source se build karo, ya `SKIP_LLAMA=1` + apna binary |
| Chat me "engine ready nahi" | Models page → Load. Error logs wahan dikhte hain |
| Preview khali | Workspace me `index.html` nahi hai — AI se HTML banwao |
| Tokens ruk-ruk ke aate hain | Reverse proxy me `proxy_buffering off;` lagao |
| Download fail (HuggingFace) | Server ka internet / DNS check karo, ya `data/models/` me `.gguf` manually daalo + Re-scan |
| Port busy | `forge port 4041` |

Logs: `forge logs` ya UI → Models → Logs.

---

## API (chhota)

```
GET    /api/health                     (public)
POST   /api/auth/setup | login | logout
GET    /api/system                     host + engine + settings
GET    /api/models                     catalog + installed + progress
POST   /api/models/download {id|url}
POST   /api/models/load {id} | unload
GET    /api/chats | POST | GET/:id | PATCH/:id | DELETE/:id
POST   /api/chat                       SSE: start → token* → done
POST   /api/chat/stop
GET    /api/files                      tree + stats
GET    /api/file?path=   PUT  /api/file   DELETE /api/file?path=
POST   /api/files/apply {files:[…]} ya {text:"…"}
GET    /api/files/zip
GET    /api/preview?path=
POST   /api/settings
```

`POST /api/chat` ka stream:

```
data: {"type":"start","chatId":"c-…"}
data: {"type":"token","t":"Maine"}
…
data: {"type":"done","files":["index.html"],"tokensPerSec":6.4,"aborted":false}
```

---

## Architecture

```
server.js          HTTP + static + banner + shutdown (engine bhi band)
src/llm.js         llama-server supervisor + OpenAI-compatible streaming client
src/models.js      GGUF catalog, download (progress), RAM-based recommend
src/project.js     workspace: tree/read/write/apply/zip/preview (css+js inline)
src/prompts.js     system prompts + FILE PROTOCOL (path= fences)
src/routes.js      poora API + SSE chat proxy + auto-apply
src/store.js       panel.json + chats/<id>.json (atomic writes)
src/auth.js        scrypt, sessions, rate limit
src/util.js        exec, safe paths, CRC32 zip writer
public/            SPA (vanilla JS + CSS)
scripts/           install / service / uninstall
tests/             mock-llm, api-test, engine-test, ui-smoke
```

---

## Develop

```bash
node server.js
node tests/api-test.js        # 45 checks (mock engine)
node tests/engine-test.js     # 17 checks (panel khud engine spawn karta hai)
npm i --no-save jsdom && node tests/ui-smoke.js   # 33 checks (UI)
```

`tests/mock-llm.js` ek OpenAI-compatible fake engine hai — real model ke bina poora panel test ho jata hai.

---

## Honest limits

- **Quality**: 1.5B/3B models chhote hain. Inhe "junior developer" samjho — speed se likhte hain, galti bhi karte hain. Code review karo.
- **Speed**: GPU nahi hai to CPU par 2–12 tok/s. 300-line file me 2-4 minute lag sakte hain.
- **Context**: 4096 tokens (~3000 words). Bada project = chhote hisson me kaam karwao.
- **Multi-user**: ek admin panel hai, roles nahi. Dost ko dena ho to alag instance (`PORT=4041 APP_DIR=/opt/forge2`) chalao.
- **Sandbox**: AI ka code **aapke folder me** likhta hai, chalata nahi. Kuch bhi run karne se pehle padho.

---

## Uninstall

```bash
sudo bash scripts/uninstall.sh          # panel hatao, data rakho
sudo bash scripts/uninstall.sh --purge  # sab (models + chats + workspace)
```

## License

MIT
