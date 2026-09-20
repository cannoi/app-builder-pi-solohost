'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const appManager = require('./lib/app-manager');
const store = require('./lib/store');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  res.writeHead(status, {
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(payload);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function localAppPage(title, icon, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(1200px 700px at 50% -10%, #1a1c22 0%, #0c0d10 55%);
      color: #eceae6; display: grid; place-items: center; padding: 32px;
    }
    main { text-align: center; max-width: 420px; }
    .mark { font-size: 42px; margin-bottom: 12px; }
    h1 { font-weight: 420; letter-spacing: .18em; text-transform: uppercase; font-size: 13px; color: #9a9790; margin: 0 0 10px; }
    p { color: #c8c4bc; line-height: 1.6; font-size: 15px; }
    .hint { color: #6f6c66; font-size: 12px; letter-spacing: .04em; }
  </style>
</head>
<body>
  <main>
    <div class="mark">${icon}</div>
    <h1>${title}</h1>
    ${body}
  </main>
</body>
</html>`;
}

const localApps = {
  calculator: localAppPage('Calculator', '∑', '<p>A quiet place for numbers. Connect a registered SoloHost calculator to replace this surface.</p><p class="hint">Gateway route /apps/calculator</p>'),
  music: localAppPage('Music', '♪', '<p>Listening room is ready. Point this route at your SoloHost music app when it is installed.</p><p class="hint">Gateway route /apps/music</p>'),
  ai: localAppPage('AI', '◎', '<p>Local assistant surface. Pi Account remains optional in V1. No keys or seed phrases are stored here.</p><p class="hint">Gateway route /apps/ai</p>'),
  node: localAppPage('Node', '⬡', '<p>Node status will appear here when the SoloHost node app is registered.</p><p class="hint">Gateway route /apps/node</p>')
};

function safePublicPath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? '/index.html' : clean;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  let file = safePublicPath(urlPath);
  if (!file) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(index) && !urlPath.startsWith('/api')) {
      file = index;
    } else {
      return false;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const stream = fs.createReadStream(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  stream.pipe(res);
  return true;
}

function proxyTo(targetUrl, req, res) {
  let dest;
  try {
    dest = new URL(targetUrl);
  } catch {
    return send(res, 502, 'Invalid app target', { 'Content-Type': 'text/plain' });
  }
  const lib = dest.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: dest.host };
  delete headers['content-length'];
  const proxyReq = lib.request(
    {
      protocol: dest.protocol,
      hostname: dest.hostname,
      port: dest.port,
      path: dest.pathname + dest.search,
      method: req.method,
      headers,
      timeout: 8000
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) send(res, 502, 'App gateway unreachable', { 'Content-Type': 'text/plain' });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) send(res, 504, 'App gateway timeout', { 'Content-Type': 'text/plain' });
  });
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') req.pipe(proxyReq);
  else proxyReq.end();
}

async function handleAppGateway(id, req, res) {
  await appManager.discover();
  const internal = appManager.getInternal(id);
  if (internal && internal.target && /^https?:\/\//i.test(internal.target)) {
    return proxyTo(internal.target, req, res);
  }
  const html =
    localApps[id] ||
    (internal
      ? localAppPage(internal.name, '◇', `<p>${internal.description || 'This SoloHost application is registered.'}</p><p class="hint">No public target is configured for this route.</p>`)
      : null);
  if (!html) {
    return send(res, 404, localAppPage('Not found', '○', '<p>No SoloHost app is registered at this route.</p>'), {
      'Content-Type': 'text/html; charset=utf-8'
    });
  }
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    const method = req.method || 'GET';

    if (p === '/health') {
      return json(res, 200, { status: 'ok', service: 'solohost-browser', timestamp: new Date().toISOString() });
    }
    if (p === '/api/hub') {
      return json(res, 200, {
        name: 'SoloHost Browser',
        status: 'active',
        version: '2.0.0',
        features: ['App Discovery', 'App Gateway', 'Bookmarks', 'History']
      });
    }
    if (p === '/api/status') {
      const discovered = await appManager.discover();
      return json(res, 200, {
        solohost: discovered.ok ? 'online' : 'offline',
        source: discovered.source,
        apps: discovered.apps.length,
        auth: { available: false, optional: true }
      });
    }
    if (p === '/api/apps') {
      try {
        const discovered = await appManager.discover();
        if (!discovered.ok && !discovered.apps.length) {
          return json(res, 503, { ok: false, error: 'My Apps unavailable', apps: [] });
        }
        return json(res, 200, {
          ok: true,
          source: discovered.source,
          apps: discovered.apps.map(appManager.publicApp)
        });
      } catch {
        return json(res, 503, { ok: false, error: 'My Apps unavailable', apps: [] });
      }
    }
    if (p === '/api/bookmarks' && method === 'GET') {
      return json(res, 200, { bookmarks: await store.listBookmarks() });
    }
    if (p === '/api/bookmarks' && method === 'POST') {
      const body = await readBody(req);
      const link = String(body.url || '').trim();
      const title = String(body.title || link).trim().slice(0, 180);
      if (!link) return json(res, 400, { error: 'url required' });
      const row = await store.addBookmark(title, link);
      return json(res, 200, { ok: true, bookmark: row });
    }
    if (p.startsWith('/api/bookmarks/') && method === 'DELETE') {
      await store.removeBookmark(p.split('/').pop());
      return json(res, 200, { ok: true });
    }
    if (p === '/api/history' && method === 'GET') {
      return json(res, 200, { history: await store.listHistory() });
    }
    if (p === '/api/history' && method === 'POST') {
      const body = await readBody(req);
      const link = String(body.url || '').trim();
      const title = String(body.title || link).trim().slice(0, 180);
      if (!link) return json(res, 400, { error: 'url required' });
      await store.addHistory(title, link);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/auth/status') {
      return json(res, 200, { authenticated: false, optional: true, provider: 'pi-account', ready: true });
    }
    if (p.startsWith('/apps/')) {
      return handleAppGateway(p.slice(6).split('/')[0], req, res);
    }

    if (method === 'GET' || method === 'HEAD') {
      if (serveStatic(req, res, p)) return;
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    console.error(err);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SoloHost Browser running on port ${PORT}`);
});
