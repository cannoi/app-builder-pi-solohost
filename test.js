/**
 * Real HTTP integration tests for /v1/* (no dependency on full express install).
 * Uses a minimal Express-compatible router so mountOpenAICompat can register routes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAiKernel } from './ai-app-kernel/src/index.js';
import { mountOpenAICompat } from './openai-compat.js';

function createMiniApp() {
  const routes = [];
  const app = {
    get(p, ...h) { routes.push({ method: 'GET', path: p, handlers: h }); },
    post(p, ...h) { routes.push({ method: 'POST', path: p, handlers: h }); },
    put(p, ...h) { routes.push({ method: 'PUT', path: p, handlers: h }); },
    patch(p, ...h) { routes.push({ method: 'PATCH', path: p, handlers: h }); },
    delete(p, ...h) { routes.push({ method: 'DELETE', path: p, handlers: h }); },
    use() {},
    _routes: routes
  };
  return app;
}

function runHandlers(handlers, req, res) {
  let i = 0;
  const next = (err) => {
    if (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
      return;
    }
    const h = handlers[i++];
    if (!h) return;
    try {
      const out = h(req, res, next);
      if (out && typeof out.then === 'function') out.catch(next);
    } catch (e) {
      next(e);
    }
  };
  next();
}

function listen(app, kernel) {
  // Also mount native chat for legacy test
  kernel.mount(app, '/api/v1');
  mountOpenAICompat(app, { kernel, serviceName: 'personal-ai-hub' });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const method = req.method || 'GET';
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let json = {};
      if (body) {
        try { json = JSON.parse(body); } catch { json = {}; }
      }
      const route = app._routes.find(r => r.method === method && r.path === url.pathname);
      if (!route) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'NOT_FOUND', path: url.pathname }));
        return;
      }
      const headers = req.headers;
      const fakeReq = {
        method,
        path: url.pathname,
        url: req.url,
        headers,
        body: json,
        query: Object.fromEntries(url.searchParams),
        get(name) {
          const k = String(name).toLowerCase();
          if (k === 'host') return headers.host;
          return headers[k];
        }
      };
      const fakeRes = {
        statusCode: 200,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        setHeader(k, v) { this.headers[k] = v; },
        json(obj) {
          this.setHeader('Content-Type', 'application/json');
          res.statusCode = this.statusCode;
          for (const [k, v] of Object.entries(this.headers)) res.setHeader(k, v);
          res.end(JSON.stringify(obj));
        },
        end(s) {
          res.statusCode = this.statusCode;
          for (const [k, v] of Object.entries(this.headers)) res.setHeader(k, v);
          res.end(s);
        }
      };
      runHandlers(route.handlers, fakeReq, fakeRes);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function httpJson(port, method, urlPath, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, text };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paihub-'));
const store = { async list() { return []; }, async put() {} };
const actions = { async invoke() { return { ok: true }; }, list() { return []; } };

const fetchImpl = async (url) => {
  const u = String(url);
  if (u.includes('/api/tags')) {
    return new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:1.5b' }] }), { status: 200 });
  }
  if (u.includes('/api/chat')) {
    return new Response(JSON.stringify({ message: { content: 'local-hello' }, model: 'qwen2.5-coder:1.5b' }), { status: 200 });
  }
  if (u.includes('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 });
  }
  if (u.includes('/chat/completions')) {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'cloud-hello' } }], model: 'gpt-4o-mini' }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: 'nf' }), { status: 404 });
};

const kernel = createAiKernel({
  store, actions,
  vaultFile: path.join(tmp, 'v.json'),
  logFile: path.join(tmp, 'l.json'),
  stateFile: path.join(tmp, 's.json'),
  fetchImpl,
  providers: {
    openai: { id: 'openai', name: 'OpenAI', type: 'openai-compatible', baseUrl: 'https://example.test/v1', models: ['gpt-4o-mini'] },
    local: { id: 'local', name: 'Local', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [] }
  }
});

await kernel.keys.addKey({ provider: 'local', token: '' });
await kernel.keys.addKey({ provider: 'openai', token: 'sk-test-abcdefghijklmnop' });

const app = createMiniApp();
const { server, port } = await listen(app, kernel);

// 1) /v1/health
{
  const r = await httpJson(port, 'GET', '/v1/health');
  assert.equal(r.status, 200, 'v1 health');
  assert.equal(r.json.hub, 'healthy');
}

// 2) /v1/models BEFORE gateway token — must include auto + local model
{
  const r = await httpJson(port, 'GET', '/v1/models');
  assert.equal(r.status, 200, 'v1 models open');
  assert.equal(r.json.object, 'list');
  assert.ok(Array.isArray(r.json.data));
  assert.ok(r.json.data.some(m => m.id === 'auto'), 'has auto');
  assert.ok(
    r.json.data.some(m => String(m.id).includes('qwen2.5-coder')),
    `local model missing: ${JSON.stringify(r.json.data.map(x => x.id))}`
  );
}

// 3) chat completions model=auto
{
  const r = await httpJson(port, 'POST', '/v1/chat/completions', {
    model: 'auto',
    messages: [{ role: 'user', content: 'hello' }]
  }, { 'X-SoloHost-App-ID': 'app-builder' });
  assert.equal(r.status, 200, `chat auto: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.object, 'chat.completion');
  assert.ok(r.json.choices[0].message.content);
}

// 4) stream=true rejected
{
  const r = await httpJson(port, 'POST', '/v1/chat/completions', {
    model: 'auto', stream: true,
    messages: [{ role: 'user', content: 'x' }]
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'STREAM_NOT_SUPPORTED');
}

// 5) unknown /v1 → JSON 404
{
  const r = await httpJson(port, 'GET', '/v1/does-not-exist');
  assert.equal(r.status, 404);
  assert.ok(typeof r.json === 'object');
  assert.ok(!String(r.text).includes('<html'));
}

// 6) legacy native chat
{
  const native = await kernel.chat({ message: 'hi', appId: 'app-builder' });
  assert.ok(native.reply);
}

// 7) gateway token required after create
const tok = await kernel.gateway.createToken({ name: 'app-builder' });
assert.ok(tok.token.startsWith('pah_'));

{
  const r = await httpJson(port, 'GET', '/v1/models');
  assert.equal(r.status, 401, 'missing token rejected');
  assert.equal(r.json.error.code, 'MISSING_GATEWAY_TOKEN');
}
{
  const r = await httpJson(port, 'GET', '/v1/models', null, { Authorization: 'Bearer pah_invalid' });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'INVALID_GATEWAY_TOKEN');
}
{
  const r = await httpJson(port, 'GET', '/v1/models', null, { Authorization: `Bearer ${tok.token}` });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.some(m => m.id === 'auto'));
}
{
  const r = await httpJson(port, 'POST', '/v1/chat/completions', {
    model: 'local/qwen2.5-coder:1.5b',
    messages: [{ role: 'user', content: 'xin chao' }]
  }, {
    Authorization: `Bearer ${tok.token}`,
    'X-SoloHost-App-ID': 'app-builder'
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.choices[0].message.content);
}

// 8) index.js must call mountOpenAICompat
const indexSrc = await fs.readFile(new URL('./index.js', import.meta.url), 'utf8');
assert.ok(indexSrc.includes('mountOpenAICompat(app'));
const mountPos = indexSrc.indexOf('mountOpenAICompat(app');
const catchPos = indexSrc.indexOf("['/api', '/ai', '/v1']");
assert.ok(mountPos > 0 && catchPos > mountPos, 'mount must be before /v1 catch-all');

server.close();
console.log('ALL TESTS PASSED');
