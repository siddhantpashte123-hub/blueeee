/* VPSDeck frontend — plain JS, koi framework nahi. */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const S = {
    view: 'vms',
    authed: false,
    needsSetup: false,
    system: null,
    vms: [],
    images: { images: [], catalog: [] },
    vm: null,
    term: null,
    pollTimer: null,
    imgTimer: null,
    route: { name: 'vms', id: null, token: null }
  };

  // ---------------- helpers ----------------
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtBytes(n) {
    n = Number(n) || 0;
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }

  function toast(msg, kind = '') {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 260);
    }, kind === 'err' ? 5200 : 3200);
  }

  async function api(path, opts = {}) {
    const o = Object.assign({ headers: {} }, opts);
    if (o.body && typeof o.body !== 'string' && !(o.body instanceof Blob)) {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.body);
    }
    const res = await fetch(path, o);
    let data = null;
    const txt = await res.text();
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = { error: txt };
    }
    if (res.status === 401 && !path.startsWith('/api/public')) {
      S.authed = false;
      renderLogin();
      throw new Error(data.error || 'Login karein');
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const badge = (vm) => {
    const st = vm.status || {};
    if (st.running) return `<span class="badge green"><i class="dot"></i>${esc(st.state || 'running')}</span>`;
    return '<span class="badge"><i class="dot"></i>stopped</span>';
  };

  function stopPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = null;
    if (S.imgTimer) clearInterval(S.imgTimer);
    S.imgTimer = null;
  }

  // ---------------- shell ----------------
  function shell(active, content, { wide = false } = {}) {
    const sys = S.system || {};
    const accel = sys.accel === 'kvm' ? '<span class="badge green" title="Hardware virtualization">KVM</span>' : '<span class="badge amber" title="Software emulation — slow">TCG</span>';
    app.innerHTML = `
      <div class="topbar">
        <a class="brand" href="#/"><img src="/assets/favicon.svg" alt=""/>VPSDeck <span class="sub">v${esc(sys.version || '1.0.0')}</span></a>
        <nav class="nav">
          <a href="#/" class="${active === 'vms' ? 'active' : ''}">Mere VPS</a>
          <a href="#/images" class="${active === 'images' ? 'active' : ''}">OS Images</a>
          <a href="#/settings" class="${active === 'settings' ? 'active' : ''}">Settings</a>
        </nav>
        <div class="grow"></div>
        ${accel}
        <button class="ghost sm" id="btn-logout">Logout</button>
      </div>
      <div class="wrap">${content}</div>
    `;
    const lo = document.getElementById('btn-logout');
    if (lo)
      lo.onclick = async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        S.authed = false;
        stopPolling();
        renderLogin();
      };
  }

  // ---------------- auth screens ----------------
  function renderLogin(setup = false) {
    stopPolling();
    if (S.term) S.term.close();
    S.needsSetup = setup;
    app.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <div class="brand"><img src="/assets/favicon.svg" alt=""/>VPSDeck</div>
          <p class="lead">${setup ? 'Pehli baar? Panel ka password set karein.' : 'Apne virtual machines manage karne ke liye login karein.'}</p>
          <form id="login-form">
            <label class="field"><span class="lbl">${setup ? 'Naya password' : 'Password'}</span>
              <input type="password" id="pw" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="••••••••" autofocus />
              ${setup ? '<span class="hint">Kam se kam 6 characters. Yehi password panel kholne ke liye lagega.</span>' : ''}
            </label>
            ${setup ? '<label class="field"><span class="lbl">Password dobara</span><input type="password" id="pw2" autocomplete="new-password" /></label>' : ''}
            <button class="primary" style="width:100%;justify-content:center" type="submit">${setup ? 'Password set karein' : 'Login'}</button>
          </form>
          <p class="small mute" style="text-align:center;margin:16px 0 0">VPSDeck — QEMU based, Docker ki zaroorat nahi</p>
        </div>
      </div>`;
    const form = document.getElementById('login-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw').value;
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        if (setup) {
          const pw2 = document.getElementById('pw2').value;
          if (pw !== pw2) throw new Error('Dono password same nahi hain');
          await api('/api/auth/setup', { method: 'POST', body: { password: pw } });
          toast('Password set ho gaya', 'ok');
        } else {
          await api('/api/auth/login', { method: 'POST', body: { password: pw } });
        }
        S.authed = true;
        await boot(true);
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    };
  }

  // ---------------- views ----------------
  async function loadSystem() {
    S.system = await api('/api/system');
    return S.system;
  }

  async function loadVms() {
    const d = await api('/api/vms');
    S.vms = d.vms || [];
    return S.vms;
  }

  async function viewVms() {
    S.view = 'vms';
    await Promise.all([loadSystem().catch(() => {}), loadVms().catch(() => {})]);
    const st = (S.system && S.system.stats) || {};
    const mem = (S.system && S.system.mem) || {};
    const usedPct = mem.total ? Math.round(((mem.total - mem.free) / mem.total) * 100) : 0;
    const accelWarn =
      S.system && S.system.accel !== 'kvm'
        ? `<div class="hint-box warn">Is VPS par <b>/dev/kvm</b> nahi hai — VMs software mode (TCG) me chalenge.
            Ye kaam karta hai par slow hota hai. Hosting provider se nested virtualization ON karwayein to 10x+ fast ho jayega.</div>`
        : '';

    const cards = S.vms
      .map(
        (vm) => `
      <div class="card vm-card" data-id="${esc(vm.id)}">
        <div class="vm-top">
          <div class="vm-icon">${esc((vm.name || 'VM').slice(0, 2).toUpperCase())}</div>
          <div style="flex:1;min-width:0">
            <div class="vm-title">${esc(vm.name)}</div>
            <div class="vm-sub">${esc(vm.imageName || vm.imageId)} · SSH ${esc(vm.sshPort)}</div>
          </div>
          ${badge(vm)}
        </div>
        <div class="vm-meta">
          <span class="badge">${vm.cpu} vCPU</span>
          <span class="badge">${vm.memMB} MB RAM</span>
          <span class="badge">${vm.diskGB} GB disk</span>
          ${vm.autostart ? '<span class="badge blue">autostart</span>' : ''}
        </div>
        <div class="vm-actions">
          <button class="primary sm" data-act="open">Open</button>
          ${
            vm.status && vm.status.running
              ? '<button class="sm" data-act="stop">Stop</button><button class="sm" data-act="console">Console</button>'
              : '<button class="sm" data-act="start">Start</button>'
          }
          <button class="sm ghost" data-act="ssh" title="SSH details">SSH</button>
          <button class="sm ghost danger" data-act="delete" title="Delete">✕</button>
        </div>
      </div>`
      )
      .join('');

    const body = `
      <div class="page-head">
        <div>
          <h1>Mere VPS</h1>
          <p>${S.vms.length ? `${st.running || 0} chal rahe, ${st.total - (st.running || 0)} band` : 'Apne VPS ke andar jitne chahein virtual machines banayein'}</p>
        </div>
        <div class="spacer"></div>
        <button class="primary" id="btn-new">+ Naya VPS</button>
      </div>
      ${accelWarn}
      <div class="grid stats">
        <div class="stat"><div class="k">VMs</div><div class="v">${st.running || 0}<span class="mute" style="font-size:15px"> / ${st.total || 0}</span></div><div class="s">chal rahe / total</div></div>
        <div class="stat"><div class="k">Host RAM</div><div class="v">${usedPct}%</div><div class="s">${fmtBytes(mem.total - mem.free)} / ${fmtBytes(mem.total)}</div></div>
        <div class="stat"><div class="k">CPU cores</div><div class="v">${(S.system && S.system.cpus) || '-'}</div><div class="s">load ${(S.system && S.system.load && S.system.load.load1.toFixed(2)) || '-'}</div></div>
        <div class="stat"><div class="k">VM memory used</div><div class="v">${fmtBytes(st.rss || 0)}</div><div class="s">allocated ${fmtBytes((st.allocMem || 0) * 1048576)}</div></div>
      </div>
      ${
        S.vms.length
          ? `<div class="grid vms">${cards}</div>`
          : `<div class="empty">
               <h3>Abhi koi VPS nahi hai</h3>
               <p>Pehle ek OS image download karein, phir ek click me VM ban jayega.</p>
               <button class="primary" id="btn-new2">+ Pehla VPS banayein</button>
             </div>`
      }`;

    shell('vms', body);
    document.querySelectorAll('#btn-new, #btn-new2').forEach((b) => (b.onclick = openCreate));
    app.querySelectorAll('.vm-card').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) {
          location.hash = `#/vm/${id}`;
          return;
        }
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'open') return (location.hash = `#/vm/${id}`);
        if (act === 'console') return (location.hash = `#/vm/${id}`);
        if (act === 'ssh') return showSsh(id);
        if (act === 'start') return quickAction(id, 'start', btn);
        if (act === 'stop') return quickAction(id, 'stop', btn);
        if (act === 'delete') return confirmDelete(id);
      });
    });

    startPolling(() => viewVms().catch(() => {}), 6000);
  }

  function startPolling(fn, ms) {
    stopPolling();
    S.pollTimer = setInterval(() => {
      if (!document.hidden) fn();
    }, ms);
  }

  async function quickAction(id, action, btn) {
    if (btn) btn.disabled = true;
    try {
      await api(`/api/vms/${id}/${action}`, { method: 'POST' });
      toast(action === 'start' ? 'VM start ho raha hai…' : 'VM stop ho raha hai…', 'ok');
      if (S.route.name === 'vms') await viewVms();
      else if (S.route.name === 'vm') await viewVm(id, { keepTerm: true });
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function showSsh(id) {
    try {
      const d = await api(`/api/vms/${id}/ssh`);
      modal({
        title: 'SSH access',
        sub: `${d.user}@${d.host} — port ${d.port}`,
        body: `
          <div class="hint-box">Ye port VPS ke <b>localhost</b> par khula hai. Laptop se connect karne ke liye pehle tunnel banayein:
            <div class="mt16 mono-code" style="display:block;padding:8px">ssh -L ${d.port}:127.0.0.1:${d.port} root@${esc(d.host)}</div>
            phir: <span class="mono-code">ssh -p ${d.port} ${esc(d.user)}@127.0.0.1</span>
          </div>
          <div class="kv">
            <div class="item"><div class="k">Command</div><div class="v">${esc(d.command)}</div></div>
            <div class="item"><div class="k">User</div><div class="v">${esc(d.user)}</div></div>
            <div class="item"><div class="k">Password</div><div class="v">${esc(d.password || '—')}</div></div>
          </div>
          <div class="hint-box warn mt16">Agar aapka VPS internet par direct nahi hai (NAT ke peeche), to browser console hi sabse aasan raasta hai.</div>`,
        okText: 'Band karein'
      });
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function confirmDelete(id) {
    const vm = S.vms.find((v) => v.id === id) || S.vm;
    const ok = await confirmDialog({
      title: 'VM delete karein?',
      sub: `${vm ? vm.name : id} ka poora disk aur data hamesha ke liye chala jayega.`,
      okText: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/api/vms/${id}`, { method: 'DELETE' });
      toast('VM delete ho gaya', 'ok');
      if (S.term) {
        S.term.close();
        S.term = null;
      }
      location.hash = '#/';
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------------- create modal ----------------
  async function openCreate() {
    try {
      S.images = await api('/api/images');
    } catch (e) {
      return toast(e.message, 'err');
    }
    const installed = S.images.images.filter((i) => i.exists);
    if (!installed.length) {
      const ok = await confirmDialog({
        title: 'Pehle OS image chahiye',
        sub: 'VM banane ke liye ek base image download karna hoga (Ubuntu ~300MB). Images page par jayein?',
        okText: 'Images page kholo'
      });
      if (ok) location.hash = '#/images';
      return;
    }
    const hashMem = (S.system && Math.floor(S.system.mem.total / 1048576)) || 2048;
    const maxMem = Math.max(512, Math.min(16384, hashMem - 512));

    modal({
      title: 'Naya VPS banayein',
      sub: 'Base image se turant ek naya virtual machine ban jayega (copy-on-write disk).',
      wide: true,
      body: `
        <form id="create-form">
          <div class="row">
            <label class="field"><span class="lbl">Naam</span><input type="text" name="name" placeholder="jaise: bot-server-1" required /></label>
            <label class="field"><span class="lbl">OS image</span>
              <select name="imageId">${installed
                .map((i) => `<option value="${esc(i.id)}">${esc(i.name)} — ${esc(i.sizeText)}</option>`)
                .join('')}</select>
            </label>
          </div>
          <div class="row">
            <label class="field"><span class="lbl">CPU (vCPU)</span><input type="number" name="cpu" value="2" min="1" max="8" /></label>
            <label class="field"><span class="lbl">RAM (MB)</span><input type="number" name="memMB" value="1024" min="256" max="${maxMem}" step="256" /></label>
            <label class="field"><span class="lbl">Disk (GB)</span><input type="number" name="diskGB" value="10" min="2" max="500" /></label>
          </div>
          <div class="row">
            <label class="field"><span class="lbl">Linux user</span><input type="text" name="user" value="ubuntu" /></label>
            <label class="field"><span class="lbl">Root/user password</span>
              <div class="copy-row"><input type="text" name="password" value="${esc(randPw())}" /><button type="button" class="sm" id="gen-pw">↻</button></div>
            </label>
          </div>
          <label class="field"><span class="lbl">SSH public key (optional)</span>
            <textarea name="sshKeys" placeholder="ssh-ed25519 AAAAC3Nza..."></textarea>
            <span class="hint">Ek line me ek key. Password se bhi SSH login chalega.</span>
          </label>
          <div class="row" style="gap:18px">
            <label class="check"><input type="checkbox" name="start" checked /> Bante hi start karein</label>
            <label class="check"><input type="checkbox" name="autostart" /> Host reboot par khud start ho</label>
          </div>
          <div class="hint-box mt16">Disk copy-on-write hai — 10GB likhne par bhi shuru me sirf kuch MB jagah leta hai.</div>
          <div class="modal-foot">
            <button type="button" class="ghost" data-close>Cancel</button>
            <button type="submit" class="primary">Create VPS</button>
          </div>
        </form>`,
      after: (root) => {
        const form = root.querySelector('#create-form');
        const sel = form.querySelector('select[name=imageId]');
        const updUser = () => {
          const img = installed.find((i) => i.id === sel.value);
          if (img && img.user) form.querySelector('input[name=user]').value = img.user;
        };
        sel.onchange = updUser;
        updUser();
        form.querySelector('#gen-pw').onclick = () => {
          form.querySelector('input[name=password]').value = randPw();
        };
        form.onsubmit = async (e) => {
          e.preventDefault();
          const btn = form.querySelector('button[type=submit]');
          btn.disabled = true;
          const fd = new FormData(form);
          const payload = {
            name: fd.get('name'),
            imageId: fd.get('imageId'),
            cpu: Number(fd.get('cpu')),
            memMB: Number(fd.get('memMB')),
            diskGB: Number(fd.get('diskGB')),
            user: fd.get('user'),
            password: fd.get('password'),
            sshKeys: String(fd.get('sshKeys') || '')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
            start: fd.get('start') === 'on',
            autostart: fd.get('autostart') === 'on'
          };
          try {
            const d = await api('/api/vms', { method: 'POST', body: payload });
            closeModal();
            toast('VPS ban gaya', 'ok');
            location.hash = `#/vm/${d.vm.id}`;
          } catch (err) {
            toast(err.message, 'err');
            btn.disabled = false;
          }
        };
      }
    });
  }

  function randPw() {
    const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 12; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }

  // ---------------- VM detail ----------------
  async function viewVm(id, { keepTerm = false } = {}) {
    S.view = 'vm';
    let vm;
    try {
      vm = (await api(`/api/vms/${id}`)).vm;
    } catch (e) {
      toast(e.message, 'err');
      location.hash = '#/';
      return;
    }
    S.vm = vm;
    const running = vm.status && vm.status.running;

    const body = `
      <div class="page-head">
        <div>
          <h1 style="display:flex;align-items:center;gap:10px">${esc(vm.name)} ${badge(vm)}</h1>
          <p>${esc(vm.imageName || vm.imageId)} · created ${new Date(vm.createdAt).toLocaleString()}</p>
        </div>
        <div class="spacer"></div>
        <div class="vm-actions">
          ${running ? '<button id="a-stop">Stop</button><button id="a-restart">Restart</button>' : '<button class="primary" id="a-start">Start</button>'}
          <button class="ghost" id="a-clone">Clone</button>
          <button class="ghost" id="a-reinstall">Reinstall</button>
          <button class="ghost danger" id="a-delete">Delete</button>
        </div>
      </div>

      <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);align-items:start" id="vm-grid">
        <div class="card">
          <div class="term" id="term">
            <div class="term-head"><span class="dots"><i></i><i></i><i></i></span> serial console — ${esc(vm.name)} <span class="right badge" id="term-state">${running ? 'connecting…' : 'VM band hai'}</span></div>
            <div class="term-body" id="term-body" tabindex="0">${
              running ? '' : '\n  VM band hai. Start karne par yahan boot log dikhega.\n'
            }</div>
            <div class="term-foot">
              <span>Console par click karein, phir type karein</span>
              <span class="right"><button class="sm ghost" id="term-clear">Clear</button></span>
            </div>
          </div>
          ${
            running
              ? ''
              : `<div class="hint-box mt16">Boot hone me 20-60 second lag sakte hain (TCG mode me zyada). Login prompt aane par hi SSH kaam karega.</div>`
          }
        </div>

        <div class="grid" style="gap:14px">
          <div class="card">
            <h3 class="mt0" style="font-size:15px;margin-bottom:12px">Machine</h3>
            <div class="kv">
              <div class="item"><div class="k">vCPU</div><div class="v">${vm.cpu}</div></div>
              <div class="item"><div class="k">RAM</div><div class="v">${vm.memMB} MB</div></div>
              <div class="item"><div class="k">Disk</div><div class="v">${vm.diskGB} GB</div></div>
              <div class="item"><div class="k">PID</div><div class="v">${vm.status.pid || '—'}</div></div>
            </div>
          </div>
          <div class="card">
            <h3 class="mt0" style="font-size:15px;margin-bottom:12px">Access</h3>
            <div class="kv">
              <div class="item"><div class="k">SSH</div><div class="v">${esc(vm.user)}@127.0.0.1:${vm.sshPort}</div></div>
              <div class="item"><div class="k">Password</div><div class="v">${esc(vm.password || '—')}</div></div>
            </div>
            <div class="copy-row mt16">
              <input type="text" readonly value="ssh -p ${vm.sshPort} ${esc(vm.user)}@127.0.0.1" id="ssh-cmd" />
              <button class="sm" id="copy-ssh">Copy</button>
            </div>
            <div class="small mute mt16">Ye command VPS ke andar se chalti hai. Laptop se: pehle <span class="mono-code">ssh -L ${vm.sshPort}:127.0.0.1:${vm.sshPort} root@host</span></div>
          </div>
          <div class="card">
            <h3 class="mt0" style="font-size:15px;margin-bottom:12px">Share (doston ke liye)</h3>
            <div class="copy-row">
              <input type="text" readonly value="${esc(location.origin + '/#/console/' + vm.shareToken)}" id="share-url" />
              <button class="sm" id="copy-share">Copy</button>
            </div>
            <div class="small mute mt16">Is link se sirf console khulta hai (browser me). Panel ka control nahi milta.</div>
          </div>
        </div>
      </div>

      <div class="card mt16">
        <div class="page-head" style="margin-bottom:12px">
          <div><h2 style="font-size:16px;margin:0">Settings</h2><p class="small">CPU/RAM badalne se pehle VM stop karein.</p></div>
          <div class="spacer"></div>
        </div>
        <form id="vm-settings">
          <div class="row">
            <label class="field"><span class="lbl">Naam</span><input type="text" name="name" value="${esc(vm.name)}" /></label>
            <label class="field"><span class="lbl">vCPU</span><input type="number" name="cpu" value="${vm.cpu}" min="1" max="8" /></label>
            <label class="field"><span class="lbl">RAM (MB)</span><input type="number" name="memMB" value="${vm.memMB}" min="256" step="256" /></label>
          </div>
          <div class="row">
            <label class="field"><span class="lbl">Naya password</span><input type="text" name="password" placeholder="khali chhodein to badlega nahi" /></label>
            <label class="field"><span class="lbl">Disk resize (GB)</span>
              <div class="copy-row"><input type="number" name="diskGB" value="${vm.diskGB}" min="${vm.diskGB}" /><button type="button" class="sm" id="btn-resize">Resize</button></div>
              <span class="hint">Sirf badha sakte hain, VM band hona chahiye.</span>
            </label>
          </div>
          <label class="field"><span class="lbl">Notes</span><textarea name="notes" placeholder="is VM ka kaam kya hai…">${esc(vm.notes || '')}</textarea></label>
          <label class="check mb16"><input type="checkbox" name="autostart" ${vm.autostart ? 'checked' : ''} /> Host start hone par ye VM khud chalu ho</label>
          <div class="row">
            <button class="primary" type="submit">Save</button>
            <button class="ghost" type="button" id="btn-snapshots">Snapshots</button>
          </div>
        </form>
      </div>
    `;

    shell('vms', body);

    // actions
    const q = (sel) => document.querySelector(sel);
    if (q('#a-start')) q('#a-start').onclick = async () => {
      try {
        toast('Start ho raha hai…', 'ok');
        await api(`/api/vms/${id}/start`, { method: 'POST' });
        await viewVm(id);
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    if (q('#a-stop'))
      q('#a-stop').onclick = async () => {
        try {
          await api(`/api/vms/${id}/stop`, { method: 'POST' });
          toast('VM band ho gaya', 'ok');
          await viewVm(id);
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    if (q('#a-restart'))
      q('#a-restart').onclick = async () => {
        try {
          toast('Restart ho raha hai…', 'ok');
          await api(`/api/vms/${id}/restart`, { method: 'POST' });
          await viewVm(id);
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    q('#a-delete').onclick = () => confirmDelete(id);
    q('#a-reinstall').onclick = async () => {
      const ok = await confirmDialog({
        title: 'Reinstall karein?',
        sub: 'Disk naye siro se ban jayega — VM ka saara data delete hoga. Password/keys dobara apply honge.',
        okText: 'Reinstall',
        danger: true
      });
      if (!ok) return;
      try {
        await api(`/api/vms/${id}/reinstall`, { method: 'POST' });
        toast('Disk naya ban gaya', 'ok');
        await viewVm(id);
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    q('#a-clone').onclick = async () => {
      const name = await promptDialog({ title: 'Clone', label: 'Naye VM ka naam', value: `${vm.name}-copy` });
      if (!name) return;
      try {
        const d = await api(`/api/vms/${id}/clone`, { method: 'POST', body: { name } });
        toast('Clone ban gaya', 'ok');
        location.hash = `#/vm/${d.vm.id}`;
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    q('#copy-ssh').onclick = () => copy(q('#ssh-cmd').value, 'SSH command copy ho gaya');
    q('#copy-share').onclick = () => copy($('#share-url').value, 'Share link copy ho gaya');

    const form = q('#vm-settings');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const patch = {
        name: fd.get('name'),
        cpu: Number(fd.get('cpu')),
        memMB: Number(fd.get('memMB')),
        notes: fd.get('notes'),
        autostart: fd.get('autostart') === 'on'
      };
      const pw = String(fd.get('password') || '').trim();
      if (pw) patch.password = pw;
      try {
        await api(`/api/vms/${id}`, { method: 'PATCH', body: patch });
        toast('Save ho gaya', 'ok');
        await viewVm(id);
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    q('#btn-resize').onclick = async () => {
      const gb = Number(form.querySelector('input[name=diskGB]').value);
      try {
        await api(`/api/vms/${id}/resize`, { method: 'POST', body: { diskGB: gb } });
        toast('Disk badh gaya', 'ok');
        await viewVm(id);
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    q('#btn-snapshots').onclick = () => openSnapshots(id);

    // terminal
    if (running) {
      S.term = new Term(document.getElementById('term-body'), id, { shareToken: null, stateEl: document.getElementById('term-state') });
      S.term.open();
      q('#term-clear').onclick = () => {
        document.getElementById('term-body').textContent = '';
      };
    } else if (S.term) {
      S.term.close();
      S.term = null;
    }

    // status refresh (console ko chhed ke nahi)
    startPolling(async () => {
      try {
        const d = await api(`/api/vms/${id}`);
        const wasRunning = vm.status.running;
        vm = d.vm;
        const head = document.querySelector('.page-head h1');
        const runningNow = vm.status.running;
        if (head) head.innerHTML = `${esc(vm.name)} ${badge(vm)}`;
        if (wasRunning !== runningNow) {
          await viewVm(id);
        }
      } catch {}
    }, 5000);
  }

  function copy(text, msg) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast(msg || 'Copy ho gaya', 'ok'))
      .catch(() => toast('Copy nahi hua — manually select karein', 'err'));
  }

  // ---------------- snapshots ----------------
  async function openSnapshots(id) {
    const load = async () => {
      const d = await api(`/api/vms/${id}/snapshots`);
      return d.snapshots || [];
    };
    let snaps = await load().catch(() => []);
    const render = () => `
      <div class="copy-row mb16">
        <input type="text" id="snap-tag" placeholder="snapshot name (jaise: clean-install)" />
        <button class="primary sm" id="snap-add">Create</button>
      </div>
      ${
        snaps.length
          ? `<div class="grid" style="gap:8px">${snaps
              .map(
                (s) => `<div class="stat" style="display:flex;align-items:center;gap:10px">
                  <div style="flex:1"><div class="v" style="font-size:14px">${esc(s.tag)}</div><div class="s">${esc(s.date || '')} ${esc(s.size || '')}</div></div>
                  <button class="sm" data-restore="${esc(s.tag)}">Restore</button>
                  <button class="sm danger" data-del="${esc(s.tag)}">Delete</button>
                </div>`
              )
              .join('')}</div>`
          : '<div class="empty" style="padding:26px">Abhi koi snapshot nahi. Snapshot VM ki current state save karta hai.</div>'
      }`;
    const m = modal({
      title: 'Snapshots',
      sub: 'Snapshot se VM usi state me wapas aa sakta hai.',
      body: render(),
      okText: 'Band karein',
      after: async (root) => {
        const bind = () => {
          root.querySelector('#snap-add').onclick = async () => {
            const tag = root.querySelector('#snap-tag').value;
            try {
              const d = await api(`/api/vms/${id}/snapshots`, { method: 'POST', body: { tag } });
              snaps = d.snapshots || [];
              root.querySelector('.modal-body, .modal').innerHTML = render();
              bind();
              toast('Snapshot ban gaya', 'ok');
            } catch (e) {
              toast(e.message, 'err');
            }
          };
          root.querySelectorAll('[data-restore]').forEach((b) => {
            b.onclick = async () => {
              try {
                await api(`/api/vms/${id}/snapshots/${encodeURIComponent(b.dataset.restore)}/restore`, { method: 'POST' });
                toast('Restore ho gaya', 'ok');
              } catch (e) {
                toast(e.message, 'err');
              }
            };
          });
          root.querySelectorAll('[data-del]').forEach((b) => {
            b.onclick = async () => {
              try {
                await api(`/api/vms/${id}/snapshots/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
                snaps = snaps.filter((s) => s.tag !== b.dataset.del);
                root.querySelector('.modal').innerHTML = render();
                bind();
              } catch (e) {
                toast(e.message, 'err');
              }
            };
          });
        };
        bind();
      }
    });
    return m;
  }

  // ---------------- images ----------------
  async function viewImages() {
    S.view = 'images';
    S.images = await api('/api/images');
    const installed = S.images.images || [];
    const cat = S.images.catalog || [];
    const hasDownload = cat.some((c) => c.download && !c.download.done && !c.download.error);

    const catCards = cat
      .map((c) => {
        const dl = c.download;
        const pct = dl && dl.total ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : 0;
        const item = installed.find((i) => i.id === c.id);
        let action;
        if (item && item.exists) action = `<span class="badge green"><i class="dot"></i>ready</span>`;
        else if (dl && !dl.done && !dl.error)
          action = `<div style="min-width:150px"><div class="bar"><i style="width:${pct}%"></i></div><div class="small mute">${fmtBytes(dl.received)}${dl.total ? ' / ' + fmtBytes(dl.total) : ''}</div></div>`;
        else if (dl && dl.error) action = `<button class="sm" data-dl="${esc(c.id)}">Retry</button>`;
        else action = `<button class="primary sm" data-dl="${esc(c.id)}">Download</button>`;
        return `
          <div class="card vm-card">
            <div class="vm-top">
              <div class="vm-icon">${esc(c.name.slice(0, 2))}</div>
              <div style="flex:1"><div class="vm-title">${esc(c.name)}</div><div class="vm-sub">${esc(c.note || '')}</div></div>
            </div>
            <div class="vm-meta"><span class="badge">${esc(c.sizeText)}</span><span class="badge">user: ${esc(c.user)}</span></div>
            <div class="vm-actions">${action}<button class="sm ghost danger" data-del-img="${esc(c.id)}" ${item ? '' : 'disabled'}>Delete</button></div>
          </div>`;
      })
      .join('');

    const custom = installed.filter((i) => !cat.find((c) => c.id === i.id));
    const customHtml = custom.length
      ? `<div class="grid vms mt16">${custom
          .map(
            (i) => `<div class="card vm-card">
              <div class="vm-top"><div class="vm-icon">${esc(i.name.slice(0, 2).toUpperCase())}</div>
                <div style="flex:1"><div class="vm-title">${esc(i.name)}</div><div class="vm-sub">${esc(i.kind)} · ${esc(i.sizeText)}</div></div></div>
              <div class="vm-actions"><button class="sm ghost danger" data-del-img="${esc(i.id)}">Delete</button></div>
            </div>`
          )
          .join('')}</div>`
      : '';

    shell(
      'images',
      `
      <div class="page-head">
        <div><h1>OS Images</h1><p>VM banane ke liye base image chahiye. Cloud images me cloud-init hota hai — user/password khud set ho jate hain.</p></div>
        <div class="spacer"></div>
        <label class="btn primary" style="cursor:pointer">Upload ISO/IMG<input type="file" id="iso-file" accept=".iso,.img,.qcow2,.raw" style="display:none" /></label>
      </div>
      <div class="hint-box">Apna ISO (Windows/other Linux) upload karke bhi VM bana sakte hain, par usme OS install manually karna hoga (console se). Cloud images automatic hain.</div>
      <div class="grid vms">${catCards}</div>
      ${customHtml}
      <div class="card mt16" id="upload-card" style="display:none">
        <div class="page-head" style="margin:0 0 8px"><div><b id="up-name">Upload</b></div></div>
        <div class="bar"><i id="up-bar" style="width:0%"></i></div>
        <div class="small mute mt16" id="up-info"></div>
      </div>
    `
    );

    app.querySelectorAll('[data-dl]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api('/api/images/download', { method: 'POST', body: { id: b.dataset.dl } });
          toast('Download shuru — progress yahan dikhega', 'ok');
          viewImages();
        } catch (e) {
          toast(e.message, 'err');
          b.disabled = false;
        }
      };
    });
    app.querySelectorAll('[data-del-img]').forEach((b) => {
      b.onclick = async () => {
        const ok = await confirmDialog({ title: 'Image delete?', sub: 'Jin VMs me ye image use ho rahi hai unhe pehle delete karna hoga.', okText: 'Delete', danger: true });
        if (!ok) return;
        try {
          await api(`/api/images/${encodeURIComponent(b.dataset.delImg)}`, { method: 'DELETE' });
          toast('Image delete ho gayi', 'ok');
          viewImages();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });

    const fileInput = app.querySelector('#iso-file');
    fileInput.onchange = () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      uploadFile(f);
    };

    if (hasDownload) S.imgTimer = setInterval(() => {
      if (!document.hidden) viewImages().catch(() => {});
    }, 2000);
  }

  function uploadFile(file) {
    const card = document.getElementById('upload-card');
    const bar = document.getElementById('up-bar');
    const name = document.getElementById('up-name');
    const info = document.getElementById('up-info');
    card.style.display = 'block';
    name.textContent = file.name;
    info.textContent = `0 / ${fmtBytes(file.size)}`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/images/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => {
      const pct = e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0;
      bar.style.width = `${pct}%`;
      info.textContent = `${fmtBytes(e.loaded)} / ${fmtBytes(e.total)} (${pct}%)`;
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        toast('Upload ho gaya', 'ok');
        viewImages();
      } else {
        let msg = 'Upload fail';
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {}
        toast(msg, 'err');
        info.textContent = msg;
      }
    };
    xhr.onerror = () => toast('Upload fail (network)', 'err');
    xhr.send(file);
  }

  // ---------------- settings ----------------
  async function viewSettings() {
    S.view = 'settings';
    await loadSystem().catch(() => {});
    const sys = S.system || {};
    const s = sys.settings || {};
    shell(
      'settings',
      `
      <div class="page-head"><div><h1>Settings</h1><p>Panel aur host ki jaankari.</p></div></div>
      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start">
        <div class="card">
          <h3 class="mt0" style="font-size:15px">Panel</h3>
          <form id="set-form">
            <label class="field"><span class="lbl">SSH host (display ke liye)</span>
              <input type="text" name="sshHost" value="${esc(s.sshHost || '')}" placeholder="jaise: 203.0.113.10 ya myvps.com" />
              <span class="hint">SSH command me ye host dikhega. VPS ka public IP/domain daalein.</span>
            </label>
            <label class="field"><span class="lbl">Panel ka naam</span><input type="text" name="panelName" value="${esc(s.panelName || 'VPSDeck')}" /></label>
            <button class="primary" type="submit">Save</button>
          </form>
          <hr style="border:none;border-top:1px solid var(--line-soft);margin:20px 0" />
          <h3 style="font-size:15px">Password badlein</h3>
          <form id="pw-form">
            <label class="field"><span class="lbl">Purana password</span><input type="password" name="current" autocomplete="current-password" /></label>
            <label class="field"><span class="lbl">Naya password</span><input type="password" name="next" autocomplete="new-password" /></label>
            <button class="primary" type="submit">Password badlein</button>
          </form>
        </div>
        <div class="card">
          <h3 class="mt0" style="font-size:15px">Host</h3>
          <div class="kv">
            <div class="item"><div class="k">Hostname</div><div class="v">${esc(sys.host || '-')}</div></div>
            <div class="item"><div class="k">Node</div><div class="v">${esc(sys.node || '-')}</div></div>
            <div class="item"><div class="k">QEMU</div><div class="v">${esc(sys.qemu && sys.qemu.version ? sys.qemu.version : 'missing')}</div></div>
            <div class="item"><div class="k">Acceleration</div><div class="v">${esc(sys.accel || '-')}${sys.qemu && sys.qemu.kvmReason ? ' — ' + esc(sys.qemu.kvmReason) : ''}</div></div>
            <div class="item"><div class="k">CPU</div><div class="v">${sys.cpus || '-'} cores</div></div>
            <div class="item"><div class="k">RAM</div><div class="v">${fmtBytes(sys.mem ? sys.mem.total : 0)}</div></div>
            <div class="item"><div class="k">Panel uptime</div><div class="v">${Math.round((sys.uptime || 0) / 60)} min</div></div>
            <div class="item"><div class="k">Version</div><div class="v">${esc(sys.version || '')}</div></div>
          </div>
          <div class="hint-box mt16">
            <b>Bahut zaroori:</b> agar aapka VPS internet par direct reachable nahi hai (NAT), to panel khud tunnel se kholna hoga —
            jaise <span class="mono-code">ssh -p 443 -R0:localhost:8080 a.pinggy.io</span> ya Cloudflare Tunnel.
            Usi URL se dost bhi console use kar sakte hain.
          </div>
          <div class="hint-box warn">
            KVM nahi hai to har VM slow chalega. Zyada VMs chalane se pehle <span class="mono-code">free -m</span> dekhein — sabki RAM host ki RAM se zyada na ho.
          </div>
        </div>
      </div>
    `
    );

    document.getElementById('set-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/settings', { method: 'POST', body: { sshHost: fd.get('sshHost'), panelName: fd.get('panelName') } });
        toast('Save ho gaya', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    document.getElementById('pw-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/panel/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } });
        toast('Password badal gaya', 'ok');
        e.target.reset();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

  // ---------------- public console ----------------
  function viewPublicConsole(token) {
    stopPolling();
    app.innerHTML = `
      <div class="topbar">
        <div class="brand"><img src="/assets/favicon.svg" alt=""/>VPSDeck <span class="sub">console</span></div>
        <div class="grow"></div>
        <span class="badge" id="pub-state">connecting…</span>
      </div>
      <div class="wrap">
        <div class="term">
          <div class="term-head"><span class="dots"><i></i><i></i><i></i></span> shared serial console</div>
          <div class="term-body" id="term-body" tabindex="0"></div>
          <div class="term-foot"><span>Terminal par click karein phir keyboard se type karein</span></div>
        </div>
        <div class="hint-box mt16">Aap sirf serial console dekh/use kar rahe hain. VM ko restart ya delete karne ka access nahi hai.</div>
      </div>`;
    const body = document.getElementById('term-body');
    const state = document.getElementById('pub-state');
    let es;
    let buf = '';
    const send = debounce((text) => {
      fetch(`/api/public/console/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: text })
      }).catch(() => {});
    }, 40);

    const open = () => {
      es = new EventSource(`/api/public/console/${encodeURIComponent(token)}`);
      es.onopen = () => (state.textContent = 'connected');
      es.onerror = () => {
        state.textContent = 'disconnected';
      };
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.out) append(d.out);
        } catch {}
      };
      es.addEventListener('hello', () => (state.textContent = 'live'));
    };
    const append = (txt) => {
      buf += cleanAnsi(txt);
      if (buf.length > 200000) buf = buf.slice(-120000);
      body.textContent = buf;
      body.scrollTop = body.scrollHeight;
    };
    body.addEventListener('keydown', (e) => {
      const seq = keyToSeq(e);
      if (seq == null) return;
      e.preventDefault();
      send(seq);
    });
    body.focus();
    open();
  }

  // ---------------- terminal ----------------
  function cleanAnsi(s) {
    return String(s)
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      .replace(/\x1b[()][A-Z0-9]/g, '')
      .replace(/\r(?!\n)/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  }

  function keyToSeq(e) {
    const k = e.key;
    if (e.ctrlKey && !e.altKey && k.length === 1) {
      const code = k.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    }
    if (e.metaKey) return null;
    switch (k) {
      case 'Enter':
        return '\r';
      case 'Backspace':
        return '\x7f';
      case 'Tab':
        return '\t';
      case 'Escape':
        return '\x1b';
      case 'ArrowUp':
        return '\x1b[A';
      case 'ArrowDown':
        return '\x1b[B';
      case 'ArrowRight':
        return '\x1b[C';
      case 'ArrowLeft':
        return '\x1b[D';
      case 'Home':
        return '\x1b[H';
      case 'End':
        return '\x1b[F';
      case 'Delete':
        return '\x1b[3~';
      case 'PageUp':
        return '\x1b[5~';
      case 'PageDown':
        return '\x1b[6~';
      default:
        if (k && k.length === 1) return k;
        return null;
    }
  }

  class Term {
    constructor(el, vmId, { shareToken = null, stateEl = null } = {}) {
      this.el = el;
      this.vmId = vmId;
      this.shareToken = shareToken;
      this.stateEl = stateEl;
      this.buf = '';
      this.es = null;
      this.pending = '';
      this.timer = null;
      this.onKey = this.onKey.bind(this);
    }

    open() {
      const url = this.shareToken
        ? `/api/public/console/${encodeURIComponent(this.shareToken)}`
        : `/api/vms/${this.vmId}/console`;
      this.es = new EventSource(url);
      this.es.onopen = () => this.state('live');
      this.es.onerror = () => this.state('disconnected');
      this.es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.out) this.append(d.out);
        } catch {}
      };
      this.es.addEventListener('hello', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          this.state(`${d.name || 'vm'} — live`);
        } catch {}
      });
      this.el.addEventListener('keydown', this.onKey);
      this.el.addEventListener('click', () => this.el.focus());
      this.el.focus();
    }

    state(t) {
      if (this.stateEl) this.stateEl.textContent = t;
    }

    append(txt) {
      this.buf += cleanAnsi(txt);
      if (this.buf.length > 300000) this.buf = this.buf.slice(-200000);
      const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 40;
      this.el.textContent = this.buf;
      if (atBottom) this.el.scrollTop = this.el.scrollHeight;
    }

    onKey(e) {
      const seq = keyToSeq(e);
      if (seq == null) return;
      e.preventDefault();
      this.pending += seq;
      if (!this.timer) {
        this.timer = setTimeout(() => {
          const data = this.pending;
          this.pending = '';
          this.timer = null;
          const url = this.shareToken
            ? `/api/public/console/${encodeURIComponent(this.shareToken)}`
            : `/api/vms/${this.vmId}/console`;
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data })
          }).catch(() => {});
        }, 35);
      }
    }

    close() {
      if (this.es) this.es.close();
      this.es = null;
      this.el.removeEventListener('keydown', this.onKey);
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  // ---------------- modals ----------------
  function modal({ title, sub, body, okText = 'OK', wide = false, after, onOk }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">
        <h2>${esc(title)}</h2>
        ${sub ? `<p class="modal-sub">${sub}</p>` : ''}
        <div class="modal-body">${body}</div>
        <div class="modal-foot">
          <button class="ghost" data-close>Cancel</button>
          <button class="primary" data-ok>${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const close = () => {
      back.remove();
      document.removeEventListener('keydown', onEsc);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onEsc);
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-close]')) close();
    });
    back.querySelector('[data-ok]').onclick = async () => {
      if (onOk && (await onOk()) === false) return;
      close();
    };
    if (after) after(back);
    S._closeModal = close;
    return close;
  }

  function closeModal() {
    if (S._closeModal) S._closeModal();
    const backs = document.querySelectorAll('.modal-back');
    backs.forEach((b) => b.remove());
  }

  function confirmDialog({ title, sub, okText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal" style="max-width:440px">
          <h2>${esc(title)}</h2>
          <p class="modal-sub">${esc(sub || '')}</p>
          <div class="modal-foot">
            <button class="ghost" data-no>Cancel</button>
            <button class="${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const done = (v) => {
        back.remove();
        resolve(v);
      };
      back.querySelector('[data-no]').onclick = () => done(false);
      back.querySelector('[data-yes]').onclick = () => done(true);
      back.addEventListener('click', (e) => {
        if (e.target === back) done(false);
      });
      back.querySelector('[data-yes]').focus();
    });
  }

  function promptDialog({ title, label, value = '' }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal" style="max-width:420px">
          <h2>${esc(title)}</h2>
          <label class="field"><span class="lbl">${esc(label)}</span><input type="text" id="pv" value="${esc(value)}" /></label>
          <div class="modal-foot"><button class="ghost" data-no>Cancel</button><button class="primary" data-yes>OK</button></div>
        </div>`;
      document.body.appendChild(back);
      const input = back.querySelector('#pv');
      input.focus();
      input.select();
      const done = (v) => {
        back.remove();
        resolve(v);
      };
      back.querySelector('[data-no]').onclick = () => done(null);
      back.querySelector('[data-yes]').onclick = () => done(input.value.trim() || null);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') done(input.value.trim() || null);
        if (e.key === 'Escape') done(null);
      };
    });
  }

  // ---------------- routing ----------------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    if (!parts.length) return { name: 'vms' };
    if (parts[0] === 'vm' && parts[1]) return { name: 'vm', id: parts[1] };
    if (parts[0] === 'images') return { name: 'images' };
    if (parts[0] === 'settings') return { name: 'settings' };
    if (parts[0] === 'console' && parts[1]) return { name: 'public-console', token: parts[1] };
    return { name: 'vms' };
  }

  async function route() {
    const r = parseHash();
    S.route = r;
    if (S.term) {
      S.term.close();
      S.term = null;
    }
    if (r.name === 'public-console') return viewPublicConsole(r.token);
    if (!S.authed) return renderLogin(S.needsSetup);

    try {
      if (r.name === 'vm') return await viewVm(r.id);
      if (r.name === 'images') return await viewImages();
      if (r.name === 'settings') return await viewSettings();
      return await viewVms();
    } catch (e) {
      if (!/Login/.test(e.message)) toast(e.message, 'err');
    }
  }

  // ---------------- boot ----------------
  async function boot(afterLogin = false) {
    const st = await api('/api/auth/state').catch(() => ({ needsSetup: false, authed: false }));
    S.needsSetup = st.needsSetup;
    S.authed = st.authed;
    if (!st.authed) return renderLogin(st.needsSetup);
    if (!afterLogin) await loadSystem().catch(() => {});
    await route();
  }

  window.addEventListener('hashchange', () => route());
  boot();
})();
