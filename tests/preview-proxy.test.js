import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createPreviewHandler, createPreviewUpgradeHandler } from '../src/preview.js';
import { registerPreviewSession, unregisterPreviewSession } from '../src/runtime/preview-gateway.js';

const project = { slug: 'proxy-app', name: 'proxy-app' };
const projects = {
  get: (s) => (s === project.slug ? project : null),
  list: () => [project],
  readMetadata: async () => ({}),   // no runtime.json: only the live session counts
  sourceDir: () => '/tmp/__none__',
};

const socks = new WeakMap();
const track = (server) => { const set = new Set(); socks.set(server, set); server.on('connection', (c) => { set.add(c); c.on('close', () => set.delete(c)); }); return server; };
// upgraded (WebSocket) sockets are not covered by closeAllConnections(), so destroy them explicitly
const shut = (s) => { try { for (const c of socks.get(s) || []) c.destroy(); s.closeAllConnections?.(); s.close(); } catch { /* */ } };
function startApp(handler) {
  return new Promise((resolve) => { const s = track(http.createServer(handler)).listen(0, '127.0.0.1', () => resolve(s)); });
}
async function startBuilder() {
  const preview = createPreviewHandler({ projects });
  const server = track(http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await preview(req, res, url))) { res.statusCode = 404; res.end('builder-404'); }
  }));
  server.on('upgrade', createPreviewUpgradeHandler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}
const get = (port, p, opts = {}) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port, path: p, agent: false, ...opts }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  }).on('error', reject);
});

test("app's own 404/400/500 answers are passed through, not replaced by static files", async () => {
  const app = await startApp((req, res) => {
    if (req.url === '/api/bad') { res.statusCode = 400; return res.end('{"error":"validation"}'); }
    if (req.url === '/api/boom') { res.statusCode = 500; return res.end('boom'); }
    if (req.url === '/go') { res.statusCode = 302; res.setHeader('Location', '/next'); return res.end(); }
    res.statusCode = 404; res.end('app-404');
  });
  const builder = await startBuilder();
  registerPreviewSession(project.slug, { upstream: `http://127.0.0.1:${app.address().port}`, hostPort: app.address().port });
  try {
    const base = `/preview/${project.slug}/__app__`;
    const bad = await get(builder.address().port, `${base}/api/bad`);
    assert.equal(bad.status, 400); assert.match(bad.body, /validation/);
    assert.equal((await get(builder.address().port, `${base}/api/boom`)).status, 500);
    assert.equal((await get(builder.address().port, `${base}/missing`)).body, 'app-404');
    const redirect = await get(builder.address().port, `${base}/go`);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, `${base}/next`);
  } finally { unregisterPreviewSession(project.slug); shut(app); shut(builder); }
});

test('when the app is gone the preview says so (503) instead of showing old files', async () => {
  const app = await startApp((req, res) => res.end('hi'));
  const port = app.address().port;
  const builder = await startBuilder();
  registerPreviewSession(project.slug, { upstream: `http://127.0.0.1:${port}`, hostPort: port });
  shut(app); await new Promise((r) => setTimeout(r, 100));
  try {
    const res = await get(builder.address().port, `/preview/${project.slug}/__app__/`);
    assert.equal(res.status, 503); assert.match(res.body, /App stopped/);
  } finally { unregisterPreviewSession(project.slug); shut(builder); }
});

test('with nothing running and server code present, preview says "not running"', async () => {
  const builder = await startBuilder();
  try {
    const res = await get(builder.address().port, `/preview/${project.slug}/__app__/`);
    assert.equal(res.status, 503);
  } finally { shut(builder); }
});

test('WebSocket upgrade is piped to the app (HMR path)', async () => {
  const app = track(http.createServer());
  app.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write('pong-from-app');
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const builder = await startBuilder();
  registerPreviewSession(project.slug, { upstream: `http://127.0.0.1:${app.address().port}`, hostPort: app.address().port });
  try {
    const data = await new Promise((resolve, reject) => {
      const s = net.connect(builder.address().port, '127.0.0.1', () => {
        s.write(`GET /preview/${project.slug}/__app__/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let buf = '';
      s.on('data', (c) => { buf += c; if (buf.includes('pong-from-app')) { s.destroy(); resolve(buf); } });
      s.on('close', () => {});
      s.on('error', reject); setTimeout(() => reject(new Error('timeout')), 4000);
    });
    assert.match(data, /101 Switching Protocols/);
  } finally { unregisterPreviewSession(project.slug); shut(app); shut(builder); }
});
