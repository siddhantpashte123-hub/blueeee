# VPSDeck 🖥️

**Apne ek VPS ke andar, jitne chahein VPS.** Docker ke bina, Kubernetes ke bina — sirf QEMU + ek Node.js panel.

VPSDeck ek chhota par poora control panel hai jo aapke VPS par **real virtual machines (KVM/QEMU)** banata hai: har VM ka apna disk, apna RAM/CPU, apna Linux user, apna SSH, aur browser me **live console**. QEMU VMs VPS ke andar normal processes ki tarah chalte hain, isliye na Docker chahiye, na special hosting.

```
┌──────────────────────────────────────────────────────────┐
│  Aapka VPS (Ubuntu 22.04)                                │
│                                                          │
│   VPSDeck panel  :8080  ← browser me dashboard           │
│      ├── VM 1  (Ubuntu 24.04, 1 vCPU, 1GB)  disk.qcow2   │
│      ├── VM 2  (Alpine,      1 vCPU, 512MB) disk.qcow2   │
│      └── VM 3  (Ubuntu 22.04, 2 vCPU, 2GB)  disk.qcow2   │
└──────────────────────────────────────────────────────────┘
```

---

## Pehle sach: "unlimited VPS" ka matlab

Aap "unlimited VPS" bana sakte hain **jitna aapka VPS allow kare** — unlimited ka koi jaadu nahi hai. Har VM ko CPU, RAM aur disk chahiye:

| Aapke VPS ki RAM | Kitne VMs (1GB wale) | Note |
|---|---|---|
| 2 GB | 1 | Panel khud bhi ~120 MB leta hai |
| 4 GB | 2–3 | 3 chalenge par swap pe aa jayega |
| 8 GB | 5–6 | Comfortable |
| 16 GB | 10–12 | Achha |
| 32 GB | 20+ | I/O bound ho jayega |

Aur ek **bahut zaroori baat** — speed:

| | Kab milta hai | Speed |
|---|---|---|
| **KVM** (hardware) | VPS provider ne *nested virtualization* ON kiya ho (`/dev/kvm` dikhe) | 100% — normal VPS jaisa |
| **TCG** (software) | `/dev/kvm` nahi hai (zyadatar sasta VPS, aur wo VPS jo khud container/LXC me hai) | ~10–20% — boot 3–10 min, kaam chal jata hai par slow |

Panel dono mode me kaam karta hai aur dashboard par saaf dikhata hai aap kaunse mode me ho. **TCG me Alpine Linux sabse best chalta hai** (60 MB image), Ubuntu heavy lagta hai.

> Agar `/dev/kvm` nahi hai aur aapko bahut VMs chahiye — sasta raasta: usi panel me **Alpine + 512MB** wale VMs banao, ya provider se nested virtualization on karwao.

---

## Requirements

- Ubuntu 20.04/22.04/24.04 ya Debian 11/12 (x86_64)
- Node.js 18+ (installer khud install kar deta hai)
- `qemu-system-x86` + `qemu-utils` (installer `apt` se laga deta hai)
- Root access
- Host me 64-bit virtualization feasible ho (KVM optional)
- Internet (image download ke liye) — panel ko internet ki zaroorat nahi

Docker / systemd **optional** — systemd na ho to panel standalone mode me chalta hai.

---

## Install (1 command)

```bash
curl -fsSL https://raw.githubusercontent.com/siddhantpashte123-hub/blueeee/main/scripts/install.sh | sudo bash
```

Kya karta hai:
1. Node 18+ check/install
2. `qemu-system-x86 qemu-utils` install
3. `/dev/kvm` check aur accel mode batata hai
4. System user `vpsdeck` banata hai (kvm group me daalta hai)
5. Code `/opt/vpsdeck` me copy karta hai — **`data/` safe rehta hai** (upgrade par VMs nahi udte)
6. systemd service **ya** standalone `vpsdeck` command + `/etc/cron.d/vpsdeck` autostart
7. Panel port auto-pick karta hai (busy ho to agla free)
8. Health check + summary print karta hai

Options (env vars):

```bash
curl -fsSL .../install.sh | sudo PORT=8080 APP_DIR=/opt/vpsdeck SERVICE_USER=vpsdeck bash
# systemd-less host par force:
sudo NO_SYSTEMD=1 bash scripts/install.sh
# QEMU pehle se installed hai to apt skip:
sudo SKIP_QEMU=1 bash scripts/install.sh
# specific version:
sudo VPSDECK_REF=<commit-sha> bash scripts/install.sh
```

Manual install:

```bash
sudo apt update && sudo apt install -y qemu-system-x86 qemu-utils
git clone <repo> vpsdeck && cd vpsdeck
sudo PORT=8080 node server.js      # ya: PORT=8080 npm start
```

---

## Pehle 5 minute

1. **Panel kholein** — `http://<vps-ip>:8080` (internet par direct nahi hai to neeche tunnel dekhein)
2. **Password set karein** — pehli baar panel khud setup screen dikhata hai (kam se kam 6 characters)
3. **OS Images** page → "Ubuntu 24.04" ya "Alpine" par **Download** (Alpine 60 MB, Ubuntu ~300 MB)
4. **+ Naya VPS** → naam, CPU, RAM, disk, user, password → Create
5. VM card par **Console** → browser me boot log aayega (`login:` prompt)
6. Wahi user/password se console me login karein ya **SSH** se judein

VM 30 second me ban jata hai. Boot time: KVM par ~15–30s, TCG par 3–10 min (Alpine fastest).

---

## VM ke andar ghusne ke 3 raaste

### 1. Browser console (sabse aasan)

VM page par serial console live chalta hai. Click karke type karein — Enter, arrows, Ctrl+C sab kaam karte hain. Boot problems yahin dikhti hain (kernel panic, cloud-init error, login prompt).

### 2. SSH (VPS ke andar se)

Har VM ko ek host port milta hai (22000 se shuru), jo sirf `127.0.0.1` par khula hai:

```bash
# VPS par ssh karne ke baad:
ssh -p 22001 ubuntu@127.0.0.1
```

Port aur password VM page ke "Access" card me dikhte hain.

### 3. Laptop se SSH (tunnel ke saath)

Aapka VPS NAT ke peeche hai to pehle ek local-forward tunnel banayein:

```bash
# laptop par — VPS ka SSH 22 khula hona chahiye
ssh -L 22001:127.0.0.1:22001 root@<vps-ip>
# phir dusre terminal me:
ssh -p 22001 ubuntu@127.0.0.1
```

### Doston ko dena hai?

Har VM ke "Share" card me ek **console link** hota hai:

```
https://<panel-url>/#/console/<random-token>
```

Ye link sirf wahi VM ka terminal kholta hai — panel ka control, delete, ya doosre VMs ka access nahi milta. Token VM page se kabhi bhi naya bana sakte hain (reinstall/delete karne par purana link mar jata hai).

> Share link ke liye panel internet se reachable hona chahiye (tunnel/domain). Neeche dekhein.

---

## Panel internet par kaise laayein (NAT ke peeche ho to)

Agar `http://<vps-ip>:8080` nahi khul raha (private IP / NAT), do options:

**Pinggy (free, test ke liye):**

```bash
ssh -p 443 -R0:localhost:8080 a.pinggy.io     # URL terminal me milega
ssh -p 443 -R0:localhost:8080 qr@a.pinggy.io  # QR code ke saath
```

**Cloudflare Tunnel (permanent):**

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cloudflared tunnel --url http://localhost:8080
```

Dono me URL public hota hai — **strong password rakhein**, aur kaam khatam hone par tunnel band kar dein. Permanent solution: domain + Nginx/Caddy reverse proxy (HTTPS) — `proxy_buffering off;` lagayein taaki console stream na ruke:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

---

## VM management

| Kaam | Kaise |
|---|---|
| **Start / Stop / Restart** | VM card ya VM page ke buttons |
| **Console** | VM page (live serial), share link se bhi |
| **CPU / RAM badalna** | Settings → VM stop karke save karein |
| **Disk badhana** | Settings → Resize (sirf badha sakte hain, VM band ho) |
| **Clone** | poori VM ki copy (naya password, naya port) |
| **Reinstall** | disk naye siro se (cloud-init dobara chalta hai — naya password/key apply) |
| **Snapshots** | Create / Restore / Delete (chal rahi VM par bhi) |
| **Autostart** | host reboot par VM khud chalu |
| **Delete** | disk + config hamesha ke liye jaata hai |

Sab kuch `data/` me rehta hai:

```
/opt/vpsdeck/data/
├── panel.json          # config (VM list, password hash, settings)
├── port                # panel port
├── panel.pid, panel.log
├── images/             # base images (Ubuntu/Debian/Alpine) + uploaded ISOs
└── vms/<vm-id>/
    ├── disk.qcow2      # VM ka disk (base image ka overlay — patla file)
    ├── seed.iso        # cloud-init: user, password, SSH keys
    ├── qemu.pid        # qemu process id
    ├── qmp.sock        # control socket (QEMU)
    └── serial.sock     # console socket
```

**Disk space tip:** disk `copy-on-write` hai — 20 GB ka VM banane par shuru me sirf kuch MB leta hai, jitna likhenge utna badhega.

---

## Errors jo aapko mil sakte hain (aur unka matlab)

| Message | Matlab / fix |
|---|---|
| `QEMU installed nahi hai` | `sudo apt install -y qemu-system-x86 qemu-utils`, phir `vpsdeck restart` |
| `/dev/kvm nahi mila` | VMs chalenge, par TCG (slow). Provider se nested virtualization on karwayein |
| `permission denied /dev/kvm` | `sudo usermod -aG kvm vpsdeck && vpsdeck restart` |
| `QEMU start nahi hua` | RAM kam hai ya KVM permission; `vpsdeck logs` dekhein, VM ki RAM kam karein |
| Console par kuch nahi | VM boot ho raha hai (TCG me 5 min tak), ya image me cloud-init/serial console support nahi |
| SSH connect nahi ho raha | VM ka boot pura hone do (login prompt dekho), port sahi hai? `ss -ltn \| grep 22` |
| `Free SSH port nahi mila` | 22000–22999 poore ho gaye — kuch VMs delete karein ya `SSH_PORT_BASE` badlein |
| Panel port busy | `vpsdeck port 9090` (ya `PORT=9090` se reinstall) |
| Image download fail | Server ka internet check karein; ya ISO manually upload karein |

Logs:

```bash
vpsdeck logs                    # standalone mode
journalctl -u vpsdeck -n 100    # systemd mode
```

---

## Commands

```bash
vpsdeck start      # panel chalu
vpsdeck stop       # panel band (VMs chalte rahenge!)
vpsdeck restart
vpsdeck status     # pid, port, health
vpsdeck logs       # live log
vpsdeck port 9090  # panel ka port badlo
```

systemd mode: `systemctl status|restart vpsdeck`

Panel band karne se VMs nahi rukte (wo alag processes hain). VMs rukenge tabhi jab aap stop karein ya host reboot ho (autostart wale wapas chalu ho jate hain).

---

## Security

- Password `scrypt` (N=16384) se hash hota hai, `data/panel.json` me salt ke saath
- Session: HttpOnly cookie (`bd_vps_session`), 7 din, HTTPS par `Secure`
- Login rate-limit: 10 galat try / 5 minute per IP
- Har POST/PATCH/DELETE par origin check (CSRF)
- VM console apne unix socket par chalta hai — network par exposed nahi
- SSH ports sirf `127.0.0.1` par bind hote hain (public nahi)
- Panel root ke bajaye `vpsdeck` user se chalta hai; VMs bhi usi user ke

Kya **nahi** hai: 2FA, multi-user roles, audit log, per-VM hard quotas. Ek admin panel hai — dost ko dena ho to console share link use karein, ya har VM ka SSH (tunnel ke saath).

---

## API (chhota reference)

Sab `/api/*` routes cookie ya `Authorization: Bearer <token>` maangte hain (`/api/health` chhod ke).

```
POST   /api/auth/setup            { password }             pehli baar
POST   /api/auth/login            { password }             cookie set
GET    /api/system                                         host + qemu info
GET    /api/vms                                            list + live status
POST   /api/vms                   { name, imageId, cpu, memMB, diskGB, user, password, sshKeys[], start }
POST   /api/vms/:id/start|stop|restart|reinstall|clone|resize
PATCH  /api/vms/:id               { name, cpu, memMB, password, autostart, notes }
DELETE /api/vms/:id
GET    /api/vms/:id/ssh                                    ssh command + password
GET    /api/vms/:id/snapshots     POST same (create), /:tag/restore, DELETE /:tag
GET    /api/vms/:id/console       SSE stream (boot log / serial)
POST   /api/vms/:id/console       { data }                 keyboard input
GET    /api/public/console/:token                          friend share link (no auth)
GET    /api/images                                         catalog + installed + progress
POST   /api/images/download       { id | url, name }
POST   /api/images/upload?name=x.iso                       raw body upload
DELETE /api/images/:id
POST   /api/settings              { sshHost, panelName }
POST   /api/panel/password        { current, next }
```

---

## Architecture (ek nazar me)

```
server.js            HTTP server, static files, banner, graceful shutdown
src/routes.js        poora REST API + SSE console proxy
src/vms.js           VM lifecycle (create/clone/reinstall/snapshot/resize)
src/qemu.js          QEMU args, start/stop, KVM vs TCG detect
src/qmp.js           QEMU Machine Protocol client (unix socket, JSON)
src/serial.js        serial console bridge (socket → SSE, input → socket)
src/iso.js           apna ISO9660+Joliet writer (cloud-init seed ke liye)
src/cloudinit.js     user-data / meta-data generation
src/images.js        base image catalog, download, upload
src/store.js         data/panel.json (serialized atomic writes)
src/auth.js          scrypt, sessions, rate limit
src/util.js          helpers (exec, ports, /proc info)
public/              SPA (vanilla JS + CSS, koi framework nahi)
scripts/             install / service / uninstall
tests/               iso-test, lifecycle-test (mock qemu), ui-smoke
```

Koi npm dependency nahi (production me). Node ke built-ins hi kaafi hain.

---

## Develop / test

```bash
node server.js                       # data/ repo ke andar
node tests/iso-test.js               # ISO + cloud-init checks
node tests/lifecycle-test.js         # poora VM lifecycle (mock QEMU — real QEMU ki zaroorat nahi)
npm i --no-save jsdom && node tests/ui-smoke.js   # UI smoke test
```

`tests/mock-qemu.js` ek fake QEMU hai jo QMP + serial sockets khol deta hai — isliye sandbox/CI me bhi poora panel test ho jata hai.

---

## Uninstall

```bash
sudo bash scripts/uninstall.sh          # panel hatao, data/VMs rakho
sudo bash scripts/uninstall.sh --purge  # sab kuch delete (VM disks bhi)
```

---

## License

MIT — `LICENSE` dekhein.
