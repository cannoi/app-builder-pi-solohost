import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, listen } from '../src/http.js';
import { createPreviewHandler, previewPath, resolvePreviewUpstream, injectPreviewBridge } from '../src/preview.js';

test('preview HTML fetch("/api") is rewritten to the preview prefix', () => {
  const html = injectPreviewBridge('<head></head><body></body>', 'snake-classic');
  assert.match(html, /data-paf-bridge/);
  assert.match(html, /\/preview\/snake-classic\/__app__/);
});

test('preview HTML rewrites root CSS and image URLs onto the app prefix', () => {
  const html = injectPreviewBridge('<head><link href="/style.css" rel="stylesheet"></head><body><img src="/logo.png"></body>', 'demo-app');
  assert.match(html, /\/preview\/demo-app\/__app__\/style\.css/);
  assert.match(html, /\/preview\/demo-app\/__app__\/logo\.png/);
  assert.match(html, /<base href="\/preview\/demo-app\/__app__\/">/);
});

test('preview proxy must use the app port, never Builder :8080 on localhost', () => {
  assert.deepEqual(
    resolvePreviewUpstream({ status: 'passed', proxyHost: '127.0.0.1', proxyPort: 45123, hostPort: 45123 }),
    { host: '127.0.0.1', port: 45123 },
  );
  assert.equal(resolvePreviewUpstream({ proxyHost: '127.0.0.1', hostPort: 8080 }), null);
});

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    }).on('error', reject);
  });
}

async function withServer(preview, fn) {
  const app = createApp();
  app.get('/health', (req, res) => res.status(200).json({ ok: true }));
  const server = listen(app, { port: 0, bind: '127.0.0.1', publicDir: '/tmp/does-not-exist', log: null, preview });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

test('a preview handler that throws still returns a real HTTP response, not a dead connection (the ERR_EMPTY_RESPONSE regression)', async () => {
  const brokenPreview = async () => { throw new Error('simulated race condition reading project metadata'); };
  await withServer(brokenPreview, async (port) => {
    const res = await get(port, '/preview/some-app/');
    assert.equal(res.status, 502);
    assert.match(res.body, /Preview error/);
    assert.match(res.body, /Back to App Builder/);
  });
});

test('a preview handler whose returned promise rejects still returns a real HTTP response', async () => {
  const brokenPreview = () => Promise.reject(new Error('async rejection, not a sync throw'));
  await withServer(brokenPreview, async (port) => {
    const res = await get(port, '/preview/some-app/');
    assert.equal(res.status, 502);
    assert.match(res.body, /Preview error/);
  });
});

test('a normal API route error is still handled as JSON (unrelated behavior is unchanged)', async () => {
  const app = createApp();
  app.get('/api/boom', () => { throw new Error('boom'); });
  const server = listen(app, { port: 0, bind: '127.0.0.1', publicDir: '/tmp/does-not-exist', log: null, preview: null });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const res = await get(port, '/api/boom');
    assert.equal(res.status, 500);
    const data = JSON.parse(res.body);
    assert.match(data.error, /boom/);
  } finally {
    server.close();
  }
});

test('a working preview returns a Builder chrome page with back link and iframe', async () => {
  const project = { id: 'proj-123', slug: 'demo-app' };
  const projects = {
    get: () => project,
    list: () => [project],
    readMetadata: async () => ({ status: 'passed', hostPort: 9, containerIp: null }),
    saveMetadata: async () => {},
    sourceDir: () => '/tmp/does-not-exist',
  };
  const preview = createPreviewHandler({ projects });
  await withServer(preview, async (port) => {
    const res = await get(port, previewPath(project.slug));
    assert.equal(res.status, 200);
    assert.match(res.body, /Back to Builder/);
    assert.match(res.body, new RegExp(`/\\?p=${project.id}`));
    assert.match(res.body, /iframe/);
    assert.match(res.body, /__app__/);
  });
});
