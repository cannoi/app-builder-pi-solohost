import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export function createApp() {
  const routes = [];

  function add(method, route, handler) {
    const { regex, keys } = compile(route);
    routes.push({ method, regex, keys, handler, route });
  }

  const app = {
    get: (r, h) => add('GET', r, h),
    post: (r, h) => add('POST', r, h),
    use() {},
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      req.path = url.pathname;
      req.query = Object.fromEntries(url.searchParams);
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const raw = await readBody(req);
        req.rawBody = raw;
        req.body = parseBody(req, raw);
      } else {
        req.body = {};
      }
      wrapRes(res);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = url.pathname.match(route.regex);
        if (!m) continue;
        req.params = {};
        route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
        try {
          await route.handler(req, res);
        } catch (err) {
          if (!res.headersSent) res.status(500).json({ error: err.message || 'Something went wrong. Try again.' });
        }
        return;
      }
      res.status(404).json({ error: 'Not found' });
    },
  };
  return app;
}

export function listen(app, { port, bind, publicDir, log, preview = null }) {
  const resolvedPublic = resolvePublicDir(publicDir);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://localhost');
    if (preview && url.pathname.startsWith('/preview/')) {
      await preview(req, res, url);
      return;
    }
    if (req.method === 'GET' && serveUi(resolvedPublic, url.pathname, res)) return;
    await app.handle(req, res);
  });
  server.listen(port, bind, () => {
    log?.info?.('Pi App Factory ready', {
      port,
      bind,
      ui: `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}/`,
      publicDir: resolvedPublic,
    });
  });
  return server;
}

function resolvePublicDir(publicDir) {
  const candidates = [
    publicDir,
    path.resolve(process.cwd(), 'public'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public'),
    '/app/public',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return publicDir || path.resolve(process.cwd(), 'public');
}

function serveUi(publicDir, pathname, res) {
  if (pathname.startsWith('/api') || pathname === '/health' || pathname === '/ready') return false;
  if (pathname === '/' || pathname === '/ui' || pathname === '/index.html') {
    const index = path.join(publicDir, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (fs.existsSync(index)) fs.createReadStream(index).pipe(res);
    else res.end(FALLBACK_UI);
    return true;
  }
  return serveStatic(publicDir, pathname, res);
}

const FALLBACK_UI = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi App Factory</title>
<style>body{font-family:system-ui;background:#0e1116;color:#e8eef6;margin:0;padding:24px}a,button{color:#fff;background:#5b4dff;border:0;border-radius:12px;padding:12px 16px;text-decoration:none;display:inline-block;margin-top:12px}</style></head>
<body><h1>App Builder — Pi SoloHost</h1><p>The main UI file is missing from this image. The API is still running.</p>
<p><a href="/health">Open health</a></p></body></html>`;

function serveStatic(publicDir, pathname, res) {
  if (pathname === '/') return false;
  const rel = pathname.replace(/^\/+/, '');
  if (rel.includes('..')) return false;
  const file = path.join(publicDir, rel);
  if (!file.startsWith(path.resolve(publicDir))) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function compile(route) {
  const keys = [];
  const pattern = route.replace(/\/:([^/]+)/g, (_, k) => {
    keys.push(k);
    return '/([^/]+)';
  }).replace(/\*$/, '(.*)');
  return { regex: new RegExp(`^${pattern}$`), keys };
}

function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 80 * 1024 * 1024) {
        reject(new Error('Upload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(req, raw) {
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { return {}; }
  }
  if (type.includes('multipart/form-data')) {
    return parseMultipart(type, raw);
  }
  return {};
}

function parseMultipart(type, raw) {
  const m = type.match(/boundary=([^;]+)/i);
  if (!m) return {};
  const boundary = Buffer.from(`--${m[1].trim()}`);
  const parts = splitBuffer(raw, boundary);
  const out = { file: null, files: [] };
  for (const part of parts) {
    const idx = indexOf(part, Buffer.from('\r\n\r\n'));
    if (idx < 0) continue;
    const head = part.slice(0, idx).toString('utf8');
    let body = part.slice(idx + 4);
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]+)"/.exec(head)?.[1];
    if (filename) { const item = { originalname: filename, buffer: body, mimetype: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() || 'application/octet-stream' }; out.files.push(item); if (!out.file) out.file = item; }
    else if (name) out[name] = body.toString('utf8');
  }
  return out;
}

function splitBuffer(buf, sep) {
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    const i = indexOf(buf, sep, start);
    if (i < 0) break;
    if (i > start) parts.push(buf.slice(start, i));
    start = i + sep.length;
  }
  return parts;
}

function indexOf(buf, seq, from = 0) {
  return buf.indexOf(seq, from);
}

export async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
