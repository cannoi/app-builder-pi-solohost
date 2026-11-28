/**
 * Preview acceptance suite A–G (real processes, no Podman/Docker, no network).
 * Browser-level checks (JS execution, clicks, keyboard) need Chromium and are NOT covered here:
 * these tests prove the engine's HTTP/process behaviour and the honesty of its status reports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { NativePreview, killProcessTree } from '../src/runtime/native-preview.js';

const cfg = { preview: { requireBrowserTest: false } };
const preview = new NativePreview({ cfg, log: { warn() {}, info() {} } });
const dirs = [];
const mk = (files = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-acc-'));
  dirs.push(root);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), typeof c === 'string' ? c : JSON.stringify(c, null, 2));
  }
  return root;
};
const get = async (port, p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const closed = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(true));
});
test.after(async () => { await preview.stopAll(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Tiny express-compatible dependency, installed with npm from a local file: path (works offline).
const FAKE_EXPRESS = {
  'vendor/fake-express/package.json': { name: 'fake-express', version: '1.0.0', main: 'index.js' },
  'vendor/fake-express/index.js': `
const http = require('http');
module.exports = function () {
  const routes = []; const app = (req, res) => {
    const r = routes.find((x) => x.m === req.method && x.p === req.url.split('?')[0]);
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      if (!r) { res.statusCode = 404; return res.end('nf'); }
      r.h({ body, url: req.url }, { json: (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); }, send: (t) => res.end(t) });
    });
  };
  app.get = (p, h) => routes.push({ m: 'GET', p, h });
  app.post = (p, h) => routes.push({ m: 'POST', p, h });
  app.listen = (port, host, cb) => http.createServer(app).listen(port, host, cb);
  return app;
};`,
};

// ───────────────────────── A. Static HTML ─────────────────────────
test('A. static HTML: page, CSS, JS, images served with right types; missing asset is a real 404; no traversal', async () => {
  const root = mk({
    'index.html': '<!doctype html><link rel="stylesheet" href="style.css"><img src="logo.svg"><button id="b">Go</button><script src="app.js"></script>',
    'style.css': 'body{color:red}', 'app.js': 'document.getElementById("b").onclick=()=>{document.title="clicked"}',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const r = await preview.run({ sourcePath: root, projectSlug: 'acc-static', timeout: 10 });
  assert.equal(r.status, 'passed'); assert.equal(r.runtimeProfile.runtime_id, 'static-web');
  assert.equal(r.evidenceLevel, 'http');
  const ct = async (p) => (await get(r.hostPort, p)).headers.get('content-type');
  assert.match(await ct('/'), /text\/html/); assert.match(await ct('/style.css'), /text\/css/);
  assert.match(await ct('/app.js'), /javascript/); assert.match(await ct('/logo.svg'), /image\/svg/);
  assert.equal((await get(r.hostPort, '/nope.js')).status, 404);          // not the index.html fallback
  assert.notEqual((await get(r.hostPort, '/..%2f..%2f..%2fetc/passwd')).status, 200);
});

test('A2. static page inside public/ is served from public/ (assets resolve)', async () => {
  const root = mk({ 'public/index.html': '<link href="a.css">ok', 'public/a.css': 'x{}' });
  const r = await preview.run({ sourcePath: root, projectSlug: 'acc-public', timeout: 10 });
  assert.equal(r.status, 'passed');
  assert.equal((await get(r.hostPort, '/a.css')).status, 200);
});

// ───────────────────────── B. JS game ─────────────────────────
test('B. JS game: served and restartable; state script is delivered intact', async () => {
  const game = 'let score=0;addEventListener("keydown",e=>{if(e.key==="ArrowUp")score++;if(e.key==="r")score=0});';
  const root = mk({ 'index.html': '<canvas id=c></canvas><script src="game.js"></script>', 'game.js': game });
  const r1 = await preview.run({ sourcePath: root, projectSlug: 'acc-game', timeout: 10 });
  assert.equal(r1.status, 'passed');
  assert.equal(await (await get(r1.hostPort, '/game.js')).text(), game);
  await preview.stop({ projectSlug: 'acc-game' });
  assert.equal(await closed(r1.hostPort), true);
  const r2 = await preview.run({ sourcePath: root, projectSlug: 'acc-game', timeout: 10 });   // restart
  assert.equal(r2.status, 'passed');
});

// ───────────────────────── C. Node.js Express ─────────────────────────
const expressApp = () => mk({
  ...FAKE_EXPRESS,
  'package.json': { name: 'api', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { 'fake-express': 'file:./vendor/fake-express' } },
  'server.js': `const express=require('fake-express');const app=express();
app.get('/health',(q,s)=>s.json({ok:true}));app.get('/api/ping',(q,s)=>s.json({pong:true}));
app.post('/api/echo',(q,s)=>s.json({got:q.body}));
app.listen(process.env.PORT,process.env.HOST||'127.0.0.1',()=>console.log('Listening on http://localhost:'+process.env.PORT));`,
});

test('C. Express: dependencies install, server starts, endpoints answer, stop → port closed, restart works', async () => {
  const root = expressApp();
  const r = await preview.run({ sourcePath: root, projectSlug: 'acc-express', timeout: 60 });
  assert.equal(r.status, 'passed', r.error);
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'fake-express', 'package.json')));
  assert.deepEqual(await (await get(r.hostPort, '/api/ping')).json(), { pong: true });
  const echo = await get(r.hostPort, '/api/echo', { method: 'POST', body: 'hello' });
  assert.deepEqual(await echo.json(), { got: 'hello' });
  assert.equal((await preview.status({ projectSlug: 'acc-express' })).status, 'running');
  await preview.stop({ projectSlug: 'acc-express' });
  assert.equal((await preview.status({ projectSlug: 'acc-express' })).status, 'stopped');
  assert.equal(await closed(r.hostPort), true);
  const r2 = await preview.run({ sourcePath: root, projectSlug: 'acc-express', timeout: 60 });
  assert.equal(r2.status, 'passed');
  assert.deepEqual(await (await get(r2.hostPort, '/api/ping')).json(), { pong: true });
});

// ───────────────────────── D. SQLite ─────────────────────────
test('D. SQLite: DB created, write/read work, data survives an app restart', async () => {
  const root = mk({
    'package.json': { name: 'db', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { 'fake-express': 'file:./vendor/fake-express' } },
    ...FAKE_EXPRESS,
    'server.js': `const express=require('fake-express');const {DatabaseSync}=require('node:sqlite');const path=require('path');
const db=new DatabaseSync(path.join(process.env.DATA_DIR,'app.db'));db.exec('create table if not exists notes(t text)');
const app=express();app.get('/health',(q,s)=>s.json({ok:true}));
app.post('/add',(q,s)=>{db.prepare('insert into notes values (?)').run(q.body);s.json({ok:true})});
app.get('/list',(q,s)=>s.json(db.prepare('select t from notes').all()));
app.listen(process.env.PORT,'127.0.0.1');`,
  });
  const r1 = await preview.run({ sourcePath: root, projectSlug: 'acc-sqlite', timeout: 60 });
  assert.equal(r1.status, 'passed', r1.error);
  await get(r1.hostPort, '/add', { method: 'POST', body: 'first' });
  assert.deepEqual(await (await get(r1.hostPort, '/list')).json(), [{ t: 'first' }]);
  await preview.stop({ projectSlug: 'acc-sqlite' });
  const r2 = await preview.run({ sourcePath: root, projectSlug: 'acc-sqlite', timeout: 60 });
  assert.equal(r2.status, 'passed', r2.error);
  assert.deepEqual(await (await get(r2.hostPort, '/list')).json(), [{ t: 'first' }]);   // persisted
});

// ───────────────────────── E. Vite / React (orchestration with a stand-in `vite`) ─────────────────────────
test('E. Vite-style app: dev deps installed, dev server launched on reserved port with strictPort, page served', async () => {
  const root = mk({
    'vendor/vite/package.json': { name: 'vite', version: '5.0.0', bin: { vite: 'cli.js' } },
    'vendor/vite/cli.js': `#!/usr/bin/env node
const a=process.argv.slice(2);const port=+a[a.indexOf('--port')+1];
if(!a.includes('--strictPort')||a[a.indexOf('--host')+1]!=='127.0.0.1'){console.error('bad flags',a);process.exit(2)}
require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<div id=root>react app</div>')}).listen(port,'127.0.0.1',()=>console.log('  Local:   http://localhost:'+port+'/'));`,
    'package.json': { name: 'web', version: '1.0.0', scripts: { dev: 'vite' }, devDependencies: { vite: 'file:./vendor/vite' } },
    'index.html': '<div id="root"></div><script type="module" src="/src/main.jsx"></script>',
    'vite.config.js': 'export default {}',
  });
  const r = await preview.run({ sourcePath: root, projectSlug: 'acc-vite', timeout: 60 });
  assert.equal(r.status, 'passed', r.error);
  assert.equal(r.runtimeProfile.runtime_id, 'vite-frontend');
  assert.match(await (await get(r.hostPort, '/')).text(), /react app/);
});

// ───────────────────────── F. Multiple previews ─────────────────────────
test('F. two previews start together, never share a port, stopping one leaves the other running', async () => {
  const [a, b] = [mk({ 'index.html': 'A' }), mk({ 'index.html': 'B' })];
  const [ra, rb] = await Promise.all([
    preview.run({ sourcePath: a, projectSlug: 'acc-multi-a', timeout: 10 }),
    preview.run({ sourcePath: b, projectSlug: 'acc-multi-b', timeout: 10 }),
  ]);
  assert.equal(ra.status, 'passed'); assert.equal(rb.status, 'passed');
  assert.notEqual(ra.hostPort, rb.hostPort);
  assert.equal(await (await get(ra.hostPort, '/')).text(), 'A');
  assert.equal(await (await get(rb.hostPort, '/')).text(), 'B');
  await preview.stop({ projectSlug: 'acc-multi-a' });
  assert.equal(await closed(ra.hostPort), true);
  assert.equal(await (await get(rb.hostPort, '/')).text(), 'B');
  assert.equal((await preview.status({ projectSlug: 'acc-multi-b' })).status, 'running');
});

test('F2. two Node apps run side by side on different ports', async () => {
  const [a, b] = [expressApp(), expressApp()];
  const [ra, rb] = await Promise.all([
    preview.run({ sourcePath: a, projectSlug: 'acc-node-a', timeout: 60 }),
    preview.run({ sourcePath: b, projectSlug: 'acc-node-b', timeout: 60 }),
  ]);
  assert.equal(ra.status, 'passed', ra.error); assert.equal(rb.status, 'passed', rb.error);
  assert.notEqual(ra.hostPort, rb.hostPort);
  await preview.stop({ projectSlug: 'acc-node-a' });
  assert.equal((await get(rb.hostPort, '/api/ping')).status, 200);
});

// ───────────────────────── G. Crash recovery / honest failures ─────────────────────────
const nodeApp = (server, extra = {}) => mk({ 'package.json': { name: 'x', version: '1.0.0', scripts: { start: 'node server.js' }, ...extra }, 'server.js': server });

test('G1. invalid package.json is identified', async () => {
  const r = await preview.run({ sourcePath: mk({ 'package.json': '{ not json', 'index.html': 'x' }), projectSlug: 'acc-g1', timeout: 10 });
  assert.equal(r.status, 'failed'); assert.equal(r.reasonCode, 'INVALID_PACKAGE_JSON');
});
test('G2. missing start script / entry is identified', async () => {
  const r = await preview.run({ sourcePath: mk({ 'package.json': { name: 'x', dependencies: { express: '^4.0.0' } } }), projectSlug: 'acc-g2', timeout: 10 });
  assert.notEqual(r.status, 'passed'); assert.equal(r.reasonCode, 'MISSING_START_SCRIPT');
});
test('G3. invalid dependency → INSTALL_FAILED (never passed)', async () => {
  const r = await preview.run({ sourcePath: nodeApp('require("http")', { dependencies: { ghost: 'file:./does-not-exist' } }), projectSlug: 'acc-g3', timeout: 60 });
  assert.equal(r.status, 'failed'); assert.equal(r.reasonCode, 'INSTALL_FAILED');
});
test('G4. undeclared library at runtime → MISSING_DEPENDENCY', async () => {
  const r = await preview.run({ sourcePath: nodeApp('require("left-padd-nope")'), projectSlug: 'acc-g4', timeout: 15 });
  assert.equal(r.status, 'failed'); assert.equal(r.reasonCode, 'MISSING_DEPENDENCY'); assert.match(r.error, /left-padd-nope/);
});
test('G5. app that crashes at start is failed with PROCESS_EXITED and leaves nothing registered', async () => {
  const r = await preview.run({ sourcePath: nodeApp('console.error("boom");process.exit(3)'), projectSlug: 'acc-g5', timeout: 15 });
  assert.equal(r.status, 'failed'); assert.equal(r.reasonCode, 'PROCESS_EXITED'); assert.match(r.error, /exit code 3/);
  assert.equal((await preview.status({ projectSlug: 'acc-g5' })).status, 'stopped');
});
test('G6. app that never listens → STARTUP_TIMEOUT is reported', async () => {
  const r = await preview.run({ sourcePath: nodeApp('setInterval(()=>{},1000)'), projectSlug: 'acc-g6', timeout: 10 });
  assert.equal(r.status, 'failed'); assert.equal(r.reasonCode, 'STARTUP_TIMEOUT');
  assert.equal((await preview.status({ projectSlug: 'acc-g6' })).status, 'stopped');
});
test('G7. port conflict: app hard-wired to a busy port is reported as PORT_CONFLICT', async () => {
  const blocker = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const busy = blocker.address().port;
  const r = await preview.run({ sourcePath: nodeApp(`require('http').createServer().listen(${busy},'127.0.0.1')`), projectSlug: 'acc-g7', timeout: 15 });
  blocker.close();
  assert.equal(r.status, 'failed'); assert.equal(r.reasonCode, 'PORT_CONFLICT');
});
test('G8. app that ignores PORT and prints where it listens is detected, not mis-reported', async () => {
  const own = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const r = await preview.run({ sourcePath: nodeApp(`require('http').createServer((q,s)=>s.end('mine')).listen(${own},'127.0.0.1',()=>console.log('Server listening on http://localhost:${own}'))`), projectSlug: 'acc-g8', timeout: 15 });
  assert.equal(r.status, 'passed', r.error); assert.equal(r.hostPort, own);
  assert.equal(await (await get(own, '/')).text(), 'mine');
});
test('G9. app killed after start is reported as crashed, never as running', async () => {
  const root = nodeApp(`require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'127.0.0.1')`);
  const r = await preview.run({ sourcePath: root, projectSlug: 'acc-g9', timeout: 15 });
  assert.equal(r.status, 'passed', r.error);
  const pid = preview.listActive().find((x) => x.slug === 'acc-g9').pid;
  process.kill(-pid, 'SIGKILL');
  await new Promise((res) => setTimeout(res, 600));
  const st = await preview.status({ projectSlug: 'acc-g9' });
  assert.equal(st.status, 'crashed');
});
test('G10. Docker-only app is preview_limited with a plain message, not a failure or a fake pass', async () => {
  const r = await preview.run({ sourcePath: mk({ Dockerfile: 'FROM alpine\nCMD ["sh"]' }), projectSlug: 'acc-g10', timeout: 5 });
  assert.equal(r.status, 'preview_limited'); assert.equal(r.reasonCode, 'CONTAINER_ONLY');
  assert.match(r.message.vi, /Docker/); assert.match(r.message.en, /Docker/);
});
