#!/usr/bin/env node
'use strict';
/**
 * Fake llama-server (OpenAI-compatible) — sirf testing ke liye.
 * Panel iske saath bilkul waise baat karta hai jaise asli engine ke saath.
 *
 *   node tests/mock-llm.js 4099
 */
const http = require('http');

// port: positional (tests) ya llama-server style --port N
const argv = process.argv.slice(2);
const portIdx = argv.findIndex((a) => a === '--port' || a === '-p');
const PORT = portIdx >= 0 ? parseInt(argv[portIdx + 1], 10) : parseInt(argv.find((a) => /^\d+$/.test(a)), 10) || 4099;
const MODEL = (() => {
  const i = argv.findIndex((a) => a === '-m' || a === '--model');
  return i >= 0 ? argv[i + 1] : 'mock-model';
})();

const FILE_ANSWER = `Maine ek clean landing page bana diya hai. Isme hero, features aur footer hai — mobile par bhi theek dikhega.

\`\`\`html path=index.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Demo</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1 class="hero">Forge se bana page</h1>
    <p>Ye file AI ne likhi hai.</p>
    <script src="app.js"></script>
  </body>
</html>
\`\`\`

Ab \`style.css\` me styling hai:

\`\`\`css path=style.css
body { font-family: system-ui; background: #0b0f19; color: #fff; }
.hero { color: #ff8a3d; }
\`\`\`

Aur thoda JavaScript:

\`\`\`js path=app.js
const el = document.querySelector('.hero');
el.addEventListener('click', () => console.log('clicked'));
\`\`\`
`;

function answerFor(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.role === 'user');
  const text = (last && last.content) || '';
  if (/NOFILE/i.test(text)) return 'Bilkul, ye ek seedha jawab hai bina kisi file ke.';
  if (/SLOW/i.test(text)) return 'slow-start ' + 'token '.repeat(60);
  return FILE_ANSWER;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const text = answerFor(body.messages);
      const chunks = text.match(/[\s\S]{1,24}/g) || [''];
      const slow = /SLOW/i.test(raw);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ choices: [{ index: 0, delta: { role: 'assistant' } }] });

      for (let i = 0; i < chunks.length; i++) {
        if (res.destroyed) return;
        send({ choices: [{ index: 0, delta: { content: chunks[i] } }] });
        await new Promise((r) => setTimeout(r, slow ? 120 : 4));
      }
      send({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        timings: { predicted_n: chunks.length, predicted_per_second: 42.5, prompt_n: 120 }
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`mock-llm listening on ${PORT} (model ${MODEL})\n`);
});

process.on('SIGTERM', () => process.exit(0));
