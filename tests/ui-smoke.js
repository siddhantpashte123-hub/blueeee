/* Headless UI smoke test (dev only, not part of the panel). */
'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');

const BASE = 'http://localhost:3000';
const PASSWORD = 'testpass123';
const html = fs.readFileSync('public/index.html', 'utf8');
const appJs = fs.readFileSync('public/assets/app.js', 'utf8');

const errors = [];
const checks = [];

function check(name, condition, extra = '') {
  checks.push({ name, ok: Boolean(condition), extra });
  if (!condition) console.log(`✗ ${name} ${extra}`);
  else console.log(`✓ ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD })
  }).then((r) => r.json());
  const token = login.token;

  const bots = await fetch(`${BASE}/api/bots`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then((r) => r.json());

  const dom = new JSDOM(html, {
    url: `${BASE}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const { document } = window;

  window.fetch = (input, init) => fetch(new URL(input, BASE).toString(), init);
  window.Headers = Headers;
  window.localStorage.setItem('bd_token', token);
  window.EventSource = class FakeEventSource {
    constructor() { this.listeners = {}; setTimeout(() => (this.listeners.open || []).forEach((fn) => fn({})), 10); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    close() {}
  };
  window.addEventListener('error', (event) => errors.push(`error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) => errors.push(`rejection: ${event.reason && event.reason.message}`));

  window.eval(appJs);

  await sleep(1600);

  check('app shell visible', !document.querySelector('#app').classList.contains('hidden'));
  check('auth screen hidden', document.querySelector('#auth').classList.contains('hidden'));
  check('sidebar has bots', document.querySelector('#side-bots').textContent.includes('Demo Bot'),
    document.querySelector('#side-bots').textContent.trim().slice(0, 80));
  check('panel name rendered', document.querySelector('#panel-name').textContent === 'BotDeck');
  check('overview stats rendered', Boolean(document.querySelector('#ov-cpu')));
  check('overview bot table', document.querySelectorAll('#ov-bots-body tr').length === bots.bots.length,
    `rows=${document.querySelectorAll('#ov-bots-body tr').length} bots=${bots.bots.length}`);
  check('system info filled', document.querySelector('#ov-system-list').textContent.includes('Node.js'));

  // ---- bots page
  window.location.hash = '#/bots';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(400);
  check('bots page table', document.querySelectorAll('#all-bots-body tr').length === bots.bots.length);
  check('bots page search', Boolean(document.querySelector('#bot-search')));

  // search filter
  const search = document.querySelector('#bot-search');
  search.value = 'Py';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(150);
  check('search filters rows', document.querySelectorAll('#all-bots-body tr').length === 1,
    `rows=${document.querySelectorAll('#all-bots-body tr').length}`);
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));

  // ---- bot console
  const nodeBot = bots.bots.find((b) => b.runtime === 'node') || bots.bots[0];
  window.location.hash = `#/bot/${nodeBot.id}/console`;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(900);

  check('bot hero rendered', document.querySelector('.bot-hero-title h2').textContent.includes(nodeBot.name));
  check('console terminal rendered', Boolean(document.querySelector('#terminal')));
  check('console has log lines', document.querySelectorAll('#terminal .log-line').length > 0,
    `lines=${document.querySelectorAll('#terminal .log-line').length}`);
  check('console actions', Boolean(document.querySelector('#console-form')));
  check('bot tabs present', document.querySelectorAll('.tab').length === 3);

  // ---- files tab
  window.location.hash = `#/bot/${nodeBot.id}/files`;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(700);
  check('files table rendered', document.querySelector('#files-body').textContent.includes('index.js'),
    document.querySelector('#files-body').textContent.trim().slice(0, 100));
  check('file breadcrumb', document.querySelector('#crumbs').textContent.includes('bot'));

  // open editor for index.js
  const editBtn = document.querySelector('#files-body [data-action="files-edit"]');
  editBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(600);
  check('editor modal opened', Boolean(document.querySelector('#editor-area')));
  const area = document.querySelector('#editor-area');
  check('editor loaded content', Boolean(area && area.value.length > 0), `len=${area && area.value.length}`);
  document.querySelector('#editor-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(600);
  check('editor modal closed after save', !document.querySelector('#editor-area'));

  // new folder modal
  document.querySelector('[data-action="files-new-folder"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  check('new folder modal', Boolean(document.querySelector('#new-folder-name')));
  document.querySelector('[data-action="close-modal"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(100);

  // ---- bot settings tab
  window.location.hash = `#/bot/${nodeBot.id}/settings`;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(400);
  check('bot settings form', Boolean(document.querySelector('#f-name')) && Boolean(document.querySelector('#f-runtime')));
  check('env row editor', Boolean(document.querySelector('[data-action="add-env"]')));
  document.querySelector('[data-action="add-env"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(100);
  check('env row added', document.querySelectorAll('[data-env-row]').length >= 1);

  // clone dialog
  document.querySelector('[data-action="clone-bot"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check('clone modal', Boolean(document.querySelector('#clone-name')));
  document.querySelector('[data-action="close-modal"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(100);

  // ---- panel settings
  window.location.hash = '#/settings';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(400);
  check('panel settings view', Boolean(document.querySelector('#panel-name-input')));
  check('password form', Boolean(document.querySelector('#pw-current')));

  // ---- new bot modal
  window.location.hash = '#/overview';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(300);
  document.querySelector('[data-action="new-bot"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check('new bot modal', Boolean(document.querySelector('#nb-name')));
  const runtime = document.querySelector('#nb-runtime');
  runtime.value = 'python';
  runtime.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('runtime hint updates', document.querySelector('#nb-runtime-hint').textContent.includes('python3'));
  document.querySelector('[data-action="close-modal"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // ---- confirm dialog
  window.location.hash = `#/bot/${nodeBot.id}/settings`;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(400);
  document.querySelector('[data-action="delete-bot"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check('delete confirm modal', Boolean(document.querySelector('#confirm-yes')));
  document.querySelector('[data-action="close-modal"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(200);

  // ---- login screen (fresh, no token)
  const dom2 = new JSDOM(html, { url: `${BASE}/`, runScripts: 'outside-only', pretendToBeVisual: true });
  dom2.window.fetch = (input, init) => fetch(new URL(input, BASE).toString(), init);
  dom2.window.Headers = Headers;
  dom2.window.EventSource = window.EventSource;
  dom2.window.addEventListener('error', (event) => errors.push(`login error: ${event.message}`));
  dom2.window.eval(appJs);
  await sleep(900);
  check('login screen shown', !dom2.window.document.querySelector('#auth').classList.contains('hidden'));
  check('login form rendered', Boolean(dom2.window.document.querySelector('#auth-password')));

  console.log('\n--- runtime errors ---');
  if (errors.length) errors.forEach((error) => console.log(error));
  else console.log('none');

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed, ${errors.length} runtime errors`);
  process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(1);
});
