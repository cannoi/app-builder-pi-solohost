import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessAuth } from '../src/security/access-auth.js';
import { externalResponseHeaders } from '../src/preview.js';
import { createApp, listen } from '../src/http.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(value) { this.body = value; },
  };
}

test('protected API and preview routes fail closed until a strong password is configured', () => {
  const auth = createAccessAuth('short');
  const res = response();
  assert.equal(auth.configured, false);
  assert.equal(auth.middleware({ path: '/api/projects', headers: {} }, res), false);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /at least 16 characters/);
});

test('login creates an HTTP-only signed session and rejects cross-origin sign-in', () => {
  const auth = createAccessAuth('a-strong-test-password-12345');
  const forbidden = response();
  auth.login({
    headers: { origin: 'https://attacker.example', host: 'builder.example' },
    body: { password: 'a-strong-test-password-12345' },
    socket: { remoteAddress: '127.0.0.1' },
  }, forbidden);
  assert.equal(forbidden.statusCode, 403);

  const accepted = response();
  auth.login({
    headers: { origin: 'https://builder.example', host: 'builder.example', 'x-forwarded-proto': 'https' },
    body: { password: 'a-strong-test-password-12345' },
    socket: { remoteAddress: '127.0.0.1' },
  }, accepted);
  assert.equal(accepted.body.ok, true);
  assert.match(accepted.headers['set-cookie'], /HttpOnly/);
  assert.match(accepted.headers['set-cookie'], /SameSite=Strict/);
  assert.match(accepted.headers['set-cookie'], /; Secure/);
  const req = { path: '/api/projects', headers: { cookie: accepted.headers['set-cookie'].split(';')[0] } };
  assert.equal(auth.isAuthenticated(req), true);
  assert.equal(auth.middleware(req, response()), true);
  assert.equal(auth.isAuthenticated({ headers: { cookie: accepted.headers['set-cookie'].split(';')[0].replace(/\.[^.]+$/, '.00') } }), false);
});

test('login limits repeated incorrect passwords', () => {
  const auth = createAccessAuth('a-strong-test-password-12345');
  for (let index = 0; index < 8; index += 1) {
    const res = response();
    auth.login({ headers: { host: 'builder.example' }, body: { password: 'incorrect' }, socket: { remoteAddress: '192.0.2.5' } }, res);
    assert.equal(res.statusCode, 401);
  }
  const limited = response();
  auth.login({ headers: { host: 'builder.example' }, body: { password: 'incorrect' }, socket: { remoteAddress: '192.0.2.5' } }, limited);
  assert.equal(limited.statusCode, 429);
});

test('external preview HTML is sandboxed without same-origin permission', () => {
  const headers = externalResponseHeaders({
    'content-type': 'text/html; charset=utf-8',
    'content-length': '123',
    'content-security-policy': 'default-src *',
    'set-cookie': 'session=secret',
  }, 'text/html; charset=utf-8');
  assert.match(headers['content-security-policy'], /^sandbox /);
  assert.doesNotMatch(headers['content-security-policy'], /allow-same-origin/);
  assert.equal(headers['content-length'], undefined);
  assert.equal(headers['set-cookie'], undefined);
  assert.equal(headers['x-content-type-options'], 'nosniff');
});

test('HTTP server protects project APIs and preview routes while leaving sign-in available', async () => {
  const auth = createAccessAuth('a-strong-test-password-12345');
  const app = createApp();
  app.use(auth.middleware);
  app.get('/api/project', (_req, res) => res.json({ private: true }));
  app.get('/api/auth/status', (req, res) => res.json({ authenticated: auth.isAuthenticated(req) }));
  const server = listen(app, {
    port: 0,
    bind: '127.0.0.1',
    publicDir: 'missing-public',
    log: null,
    preview: async (_req, res) => res.status(200).json({ private: true }),
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await fetch(`${base}/api/auth/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { authenticated: false });
    const project = await fetch(`${base}/api/project`);
    assert.equal(project.status, 401);
    const preview = await fetch(`${base}/preview/demo/`);
    assert.equal(preview.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
