import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const APP_NAME = process.env.APP_NAME || '{{APP_NAME}}';
const APP_SUMMARY = process.env.APP_SUMMARY || '{{APP_SUMMARY}}';
const items = [];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (pathname === '/health' || pathname === '/api/health') {
    return json(res, 200, { ok: true, app: APP_NAME, template: "std-ecommerce-marketplace" });
  }
  if (pathname === '/api/info') {
    return json(res, 200, {
      name: APP_NAME,
      summary: APP_SUMMARY,
      category: "ecommerce-marketplace",
      features: ["name","price"],
      api: "/api/products",
      ui: "Catalog",
    });
  }
  if (pathname === "/api/products" && req.method === 'GET') {
    return json(res, 200, { items });
  }
  if (pathname === "/api/products" && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const row = { id: String(Date.now()), ...body, createdAt: new Date().toISOString() };
      items.unshift(row);
      if (items.length > 300) items.length = 300;
      return json(res, 201, { ok: true, item: row });
    } catch {
      return json(res, 400, { ok: false, error: 'Invalid JSON body' });
    }
  }

  let filePath = path.join(root, 'public', pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''));
  if (!filePath.startsWith(path.join(root, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : 'application/octet-stream';
    let out = data;
    if (ext === '.html') {
      out = Buffer.from(String(data)
        .replaceAll('{{APP_NAME}}', APP_NAME)
        .replaceAll('{{APP_SUMMARY}}', APP_SUMMARY));
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(out);
  });
});

server.listen(PORT, HOST, () => {
  console.log(APP_NAME + ' listening on http://' + HOST + ':' + PORT);
});
