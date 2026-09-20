'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const dns = require('dns').promises;

const appManager = require('./lib/app-manager');
const store = require('./lib/store');

const PORT = Number(process.env.PORT || 8080);

const PROXY_PORT = Number(process.env.PROXY_PORT || 8081);
const PROXY_HOST = process.env.PROXY_HOST || '0.0.0.0';
const MAX_PROXY_HTML = 8 * 1024 * 1024;
const MAX_PROXY_BODY = 4 * 1024 * 1024;
const PROXY_UA = 'SoloHost-Browser/2.1 (+local web gateway)';

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}

function isPrivateIP(ip) {
  const value = String(ip || '').toLowerCase();
  if (value.includes(':')) {
    return (
      value === '::1' ||
      value === '::' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('fe80:')
    );
  }
  return isPrivateIPv4(value);
}

async function resolvePublicHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Blocked local host');
  }
  if (isPrivateIP(host)) throw new Error('Blocked private address');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((r) => isPrivateIP(r.address))) {
    throw new Error('Blocked private address');
  }
  return records[0];
}

function validateTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  if (u.username || u.password) throw new Error('Credentials in URL are not supported');
  return u;
}

function proxyUrlFor(base, target) {
  return `${base.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(target)}`;
}

function absoluteUrl(value, base) {
  try {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('#') || /^(?:javascript|mailto|tel|data|blob):/i.test(raw)) return null;
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

function rewriteSrcset(value, base, proxyBase) {
  return String(value).split(',').map((part) => {
    const m = part.trim().match(/^(\S+)(.*)$/);
    if (!m) return part;
    const abs = absoluteUrl(m[1], base);
    return abs ? `${proxyUrlFor(proxyBase, abs)}${m[2] || ''}` : part;
  }).join(', ');
}

function rewriteCss(css, targetUrl, proxyBase) {
  return String(css).replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (full, quote, value) => {
    const abs = absoluteUrl(value, targetUrl);
    return abs ? `url("${proxyUrlFor(proxyBase, abs)}")` : full;
  }).replace(/@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?/gi, (full, quote, value) => {
    const abs = absoluteUrl(value, targetUrl);
    return abs ? `@import "${proxyUrlFor(proxyBase, abs)}"` : full;
  });
}

function rewriteHtml(html, targetUrl, proxyBase) {
  let out = String(html);
  const attrRe = /\b(href|src|action|poster)\s*=\s*(["'])(.*?)\2/gi;
  out = out.replace(attrRe, (full, attr, quote, value) => {
    const abs = absoluteUrl(value, targetUrl);
    if (!abs) return full;
    return `${attr}=${quote}${proxyUrlFor(proxyBase, abs)}${quote}`;
  });
  out = out.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (full, quote, value) => {
    return `srcset=${quote}${rewriteSrcset(value, targetUrl, proxyBase)}${quote}`;
  });
  out = out.replace(/(<meta\b[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url=)([^"']+)/gi, (full, prefix, value) => {
    const abs = absoluteUrl(value.trim(), targetUrl);
    return abs ? `${prefix}${proxyUrlFor(proxyBase, abs)}` : full;
  });
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(/<meta\b[^>]*(?:http-equiv\s*=\s*["']Content-Security-Policy["']|name\s*=\s*["']content-security-policy["'])[^>]*>/gi, '');
  const marker = `<base href="${String(targetUrl).replace(/"/g, '&quot;')}">`;
  const boot = `<script>(function(){try{var P=${JSON.stringify(proxyBase)};document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(!h||/^(?:#|javascript:|mailto:|tel:|data:|blob:)/i.test(h))return;var u=new URL(h,location.href);if(/^https?:$/i.test(u.protocol)){e.preventDefault();location.href=P+'/proxy?url='+encodeURIComponent(u.href);}},true);document.addEventListener('submit',function(e){var f=e.target;if(!f||f.tagName!=='FORM')return;var action=f.getAttribute('action')||location.href;var u=new URL(action,location.href);if(!/^https?:$/i.test(u.protocol))return;e.preventDefault();var method=(f.method||'get').toLowerCase();if(method==='get'){var q=new URLSearchParams(new FormData(f));q.forEach(function(v,k){u.searchParams.append(k,v);});location.href=P+'/proxy?url='+encodeURIComponent(u.href);}else{var x=document.createElement('form');x.method=method;x.action=P+'/proxy?url='+encodeURIComponent(u.href);for(var pair of new FormData(f)){var i=document.createElement('input');i.type='hidden';i.name=pair[0];i.value=pair[1];x.appendChild(i);}document.body.appendChild(x);x.submit();}},true);}catch(e){}})();</script>`;
  if (/<head\b/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => `${m}${marker}`);
  } else {
    out = marker + out;
  }
  return out.replace(/<\/body>/i, `${boot}</body>`);
}

function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|content-length|content-encoding)$/i.test(k)) continue;
    if (/^(x-frame-options|content-security-policy|content-security-policy-report-only)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function rewriteSetCookies(values) {
  if (!Array.isArray(values)) return values;
  return values.map((v) =>
    String(v)
      .replace(/;\s*Domain=[^;]*/ig, '')
      .replace(/;\s*Secure/ig, '')
      .replace(/;\s*SameSite=None/ig, '; SameSite=Lax')
      .replace(/;\s*Path=[^;]*/ig, '; Path=/')
  );
}

function collectBody(req, limit = MAX_PROXY_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fetchProxy(targetUrl, req, res, proxyBase, redirects = 0) {
  return resolvePublicHost(targetUrl.hostname).then((resolved) => new Promise((resolve, reject) => {
    const lib = targetUrl.protocol === 'https:' ? https : http;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['accept-encoding'];
    headers['user-agent'] = headers['user-agent'] || PROXY_UA;
    headers.accept = headers.accept || '*/*';
    const options = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers,
      timeout: 15000,
      lookup: (_host, _opts, cb) => cb(null, resolved.address, resolved.family)
    };
    const upstream = lib.request(options, (upstreamRes) => {
      const location = upstreamRes.headers.location;
      if (location && upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && redirects < 5 && (req.method === 'GET' || req.method === 'HEAD')) {
        upstreamRes.resume();
        let next;
        try { next = new URL(location, targetUrl); } catch { return reject(new Error('Invalid redirect')); }
        return fetchProxy(next, req, res, proxyBase, redirects + 1).then(resolve, reject);
      }

      const headersOut = stripHopByHop(upstreamRes.headers);
      if (headersOut['set-cookie']) headersOut['set-cookie'] = rewriteSetCookies(headersOut['set-cookie']);
      if (location) {
        try {
          headersOut.location = proxyUrlFor(proxyBase, new URL(location, targetUrl).href);
        } catch {}
      }
      const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('text/css')) {
        const chunks = [];
        let size = 0;
        upstreamRes.on('data', (c) => {
          size += c.length;
          if (size > MAX_PROXY_HTML) {
            upstreamRes.destroy(new Error('Text response too large'));
            return;
          }
          chunks.push(c);
        });
        upstreamRes.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const rewritten = contentType.includes('text/css')
              ? rewriteCss(body, targetUrl.href, proxyBase)
              : rewriteHtml(body, targetUrl.href, proxyBase);
            headersOut['content-type'] = contentType.includes('text/css')
              ? 'text/css; charset=utf-8'
              : 'text/html; charset=utf-8';
            headersOut['cache-control'] = 'no-store';
            res.writeHead(upstreamRes.statusCode || 200, headersOut);
            res.end(rewritten);
            resolve();
          } catch (err) { reject(err); }
        });
        upstreamRes.on('error', reject);
      } else {
        res.writeHead(upstreamRes.statusCode || 200, headersOut);
        upstreamRes.pipe(res);
        upstreamRes.on('end', resolve);
      }
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', reject);
    if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
    else req.pipe(upstream);
  }));
}

async function handleProxyRequest(req, res, proxyBase) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const raw = requestUrl.searchParams.get('url');
    if (!raw) return send(res, 400, 'Missing url', { 'Content-Type': 'text/plain; charset=utf-8' });
    const target = validateTarget(raw);
    await fetchProxy(target, req, res, proxyBase);
  } catch (err) {
    if (!res.headersSent) {
      send(res, 502, JSON.stringify({ error: 'Web gateway failed', detail: err.message }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
    }
  }
}


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

    if (p === '/api/proxy-url') {
      const host = req.headers.host ? req.headers.host.split(':')[0] : '127.0.0.1';
      const proto = req.headers['x-forwarded-proto'] || 'http:';
      const proxyHostPort = PROXY_PORT === 80 ? host : `${host}:${process.env.PROXY_PUBLIC_PORT || 18081}`;
      return json(res, 200, { base: `${proto}//${proxyHostPort}` });
    }
    if (p === '/health') {
      return json(res, 200, { status: 'ok', service: 'solohost-browser', timestamp: new Date().toISOString() });
    }
    if (p === '/api/proxy') {
      const host = req.headers.host ? req.headers.host.split(':')[0] : '127.0.0.1';
      const proto = req.headers['x-forwarded-proto'] || 'http:';
      const proxyBase = `${proto}//${host}:${process.env.PROXY_PUBLIC_PORT || 18081}`;
      return handleProxyRequest(req, res, proxyBase);
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

const proxyServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname === '/health') return json(res, 200, { status: 'ok', service: 'solohost-web-gateway' });
  if (requestUrl.pathname === '/proxy') {
    const base = `http://${req.headers.host}`;
    return handleProxyRequest(req, res, base);
  }
  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
});
proxyServer.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`SoloHost Web Gateway running on ${PROXY_HOST}:${PROXY_PORT}`);
});
