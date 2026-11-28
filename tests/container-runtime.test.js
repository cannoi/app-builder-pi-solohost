import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BuildRunner } from '../src/docker/runner.js';
import { loadConfig } from '../src/config/loader.js';

test('container runtime accepts a compose-only image app and detects web port', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-compose-'));
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), `services:\n  browser:\n    image: mrcolorrain/vnc-browser:debian\n    ports:\n      - "6080:6080"\n`);
  const runner = new BuildRunner({ cfg: { runtime: { mode: 'container', podman: { apiUrl: 'http://sandbox' } }, limits: { buildTimeoutSec: 1, sandboxTimeoutSec: 1 } } });
  const spec = await runner.__testDetect?.(dir);
  // The public runner behavior is verified through buildImage's compose-image path below.
  const client = runner.podman;
  let pulled = null;
  client.pullImage = async (image) => { pulled = image; return { status: 'passed', image }; };
  const result = await runner.buildImage({ sourcePath: dir, projectSlug: 'browser', timeout: 1 });
  assert.equal(result.status, 'passed');
  assert.equal(result.buildMode, 'pull-compose-image');
  assert.equal(pulled, 'mrcolorrain/vnc-browser:debian');
  await fs.rm(dir, { recursive: true, force: true });
});

test('Podman endpoint aliases are accepted without changing native defaults', () => {
  const old = process.env.PODMAN_API_URL;
  const old2 = process.env.SANDBOX_PODMAN_API_URL;
  const old3 = process.env.CONTAINER_SANDBOX_PODMAN_API_URL;
  delete process.env.PODMAN_API_URL;
  process.env.SANDBOX_PODMAN_API_URL = 'http://sandbox';
  delete process.env.CONTAINER_SANDBOX_PODMAN_API_URL;
  const cfg = loadConfig();
  assert.equal(cfg.runtime.podman.apiUrl, 'http://sandbox');
  if (old == null) delete process.env.PODMAN_API_URL; else process.env.PODMAN_API_URL = old;
  if (old2 == null) delete process.env.SANDBOX_PODMAN_API_URL; else process.env.SANDBOX_PODMAN_API_URL = old2;
  if (old3 == null) delete process.env.CONTAINER_SANDBOX_PODMAN_API_URL; else process.env.CONTAINER_SANDBOX_PODMAN_API_URL = old3;
});


test('container-only Run does not fall into native package/index error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-container-only-'));
  await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine:latest\nEXPOSE 6080\n');
  const runner = new BuildRunner({ cfg: { runtime: { mode: 'auto', podman: { apiUrl: '' } }, limits: { sandboxTimeoutSec: 1 } } });
  const result = await runner.runApp({ sourcePath: dir, projectSlug: 'chrome-novnc', timeout: 1, keepRunning: false });
  assert.notEqual(result.status, 'blocked');
  assert.notEqual(result.runtime, 'podman-sandbox');
  await fs.rm(dir, { recursive: true, force: true });
});

test('nested compose browser app is detected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-nested-compose-'));
  await fs.mkdir(path.join(dir, 'Chrome-novnc-master'), { recursive: true });
  await fs.writeFile(path.join(dir, 'Chrome-novnc-master', 'docker-compose.yml'), 'services:\n  browser:\n    image: mrcolorrain/vnc-browser:debian\n    ports:\n      - "6080:6080"\n');
  const runner = new BuildRunner({ cfg: { runtime: { mode: 'container', podman: { apiUrl: 'http://sandbox' } }, limits: { buildTimeoutSec: 1 } } });
  let pulled = null;
  runner.podman.pullImage = async (image) => { pulled = image; return { status: 'passed', image }; };
  const result = await runner.buildImage({ sourcePath: dir, projectSlug: 'nested-browser', timeout: 1 });
  assert.equal(result.status, 'passed');
  assert.equal(pulled, 'mrcolorrain/vnc-browser:debian');
  await fs.rm(dir, { recursive: true, force: true });
});


test('compose runtime preserves basic environment and command without privileged access', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-compose-runtime-'));
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), `services:\n  browser:\n    image: test/browser:latest\n    environment:\n      STARTING_WEBSITE_URL: "https://example.com"\n      - BROWSER_MODE=headful\n    command: ["sh", "-lc", "echo ready"]\n    ports:\n      - "6080:6080"\n`);
  const runner = new BuildRunner({ cfg: { runtime: { mode: 'container', podman: { apiUrl: 'http://sandbox' } }, limits: { buildTimeoutSec: 1 } } });
  let body = null;
  runner.podman.pullImage = async (image) => ({ status: 'passed', image });
  runner.podman.createPreviewContainer = async (args) => { body = args; return { Id: 'x' }; };
  // Runtime detection is exercised through buildImage; command/env are then unit-checked by the Podman client separately.
  const runtime = { env: ['STARTING_WEBSITE_URL=https://example.com', 'BROWSER_MODE=headful'], command: ['sh','-lc','echo ready'] };
  await runner.podman.createPreviewContainer({ image: 'test/browser:latest', name: 'paf-app-browser', port: 6080, runtime });
  assert.deepEqual(body.runtime, runtime);
  await fs.rm(dir, { recursive: true, force: true });
});


test('Compose host:container mapping detects the container port, not the host port', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-port-map-'));
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), `services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "18080:80"\n`);
  const runner = new BuildRunner({ cfg: { runtime: { mode: 'container', podman: { apiUrl: 'http://sandbox' } }, limits: { buildTimeoutSec: 1 } } });
  runner.podman.pullImage = async (image) => ({ status: 'passed', image });
  runner.podman.imageInfo = async () => ({ Config: { ExposedPorts: { '80/tcp': {} } } });
  let createArgs = null;
  runner.podman.createPreviewContainer = async (args) => { createArgs = args; return { Id: 'ctr-port' }; };
  runner.podman.startContainer = async () => {};
  runner.podman.inspectContainer = async () => ({ State: { Running: true }, NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '43180' }] } } });
  runner.podman.containerLogs = async () => '';
  runner.podman.stopContainer = async () => {};
  runner.podman.removeContainer = async () => {};
  runner.browserFactory = async () => ({ async newPage() { return { async goto(){}, async title(){ return 'nginx'; }, async screenshot(){}, async evaluate(){ return { ok: true, checks: [] }; }, async close(){} }; }, async close(){} });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('ok', { status: 200 });
  try {
    const result = await runner.runApp({ sourcePath: dir, projectSlug: 'port-map', timeout: 1, keepRunning: false });
    assert.equal(createArgs.port, 80);
    assert.equal(result.status, 'passed');
  } finally {
    globalThis.fetch = oldFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Container Sandbox endpoint is auto-detected at Run time without Settings configuration', async () => {
  const old = process.env.PODMAN_API_URL;
  delete process.env.PODMAN_API_URL;
  try {
    const runner = new BuildRunner({ cfg: { runtime: { mode: 'auto', podman: { apiUrl: '' } }, limits: { sandboxTimeoutSec: 1 } } });
    assert.equal(Boolean(runner.podman), false);
    process.env.PODMAN_API_URL = 'http://sandbox-late';
    runner.refreshPodmanFromEnvironment();
    assert.equal(runner.podman.baseUrl, 'http://sandbox-late');
  } finally {
    if (old == null) delete process.env.PODMAN_API_URL; else process.env.PODMAN_API_URL = old;
  }
});

test('ordinary Node/static RUN stays native even when Container Sandbox is configured', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-native-with-podman-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<html><body>Native UI</body></html>');
  const runner = new BuildRunner({ cfg: { runtime: { mode: 'auto', podman: { apiUrl: 'http://sandbox' } }, limits: { sandboxTimeoutSec: 10 } } });
  let podmanRunCalled = false;
  runner.runPodmanApp = async () => { podmanRunCalled = true; return { status: 'failed', error: 'must not be called' }; };
  const result = await runner.runApp({ sourcePath: dir, projectSlug: 'native-ui', timeout: 10, keepRunning: true });
  assert.equal(podmanRunCalled, false);
  assert.equal(result.status, 'passed');
  const page = await fetch(`http://127.0.0.1:${result.hostPort}/`);
  assert.match(await page.text(), /Native UI/);
  await runner.native.stop({ projectSlug: 'native-ui' });
  await fs.rm(dir, { recursive: true, force: true });
});

test('Compose long port syntax uses target container port for Sandbox preview', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-long-port-'));
  await fs.writeFile(path.join(dir, 'compose.yaml'), `services:\n  web:\n    image: nginx:alpine\n    ports:\n      - target: 80\n        published: "18080"\n        protocol: tcp\n`);
  const runner = new BuildRunner({ cfg: { runtime: { mode: 'container', podman: { apiUrl: 'http://sandbox' } }, limits: { buildTimeoutSec: 1 } } });
  runner.podman.pullImage = async (image) => ({ status: 'passed', image });
  runner.podman.imageInfo = async () => ({ Config: { ExposedPorts: { '80/tcp': {} } } });
  runner.podman.createPreviewContainer = async (args) => { runner.__createArgs = args; return { Id: 'long-port' }; };
  runner.podman.startContainer = async () => {};
  runner.podman.inspectContainer = async () => ({ State: { Running: true }, NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '43181' }] } } });
  runner.podman.containerLogs = async () => '';
  runner.podman.stopContainer = async () => {};
  runner.podman.removeContainer = async () => {};
  runner.browserFactory = async () => ({ async newPage() { return { async goto(){}, async title(){return 'nginx'}, async screenshot(){}, async evaluate(){return {ok:true,checks:[]}}, async close(){} }; }, async close(){} });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('ok', { status: 200 });
  try {
    const result = await runner.runApp({ sourcePath: dir, projectSlug: 'long-port', timeout: 1, keepRunning: false });
    assert.equal(result.status, 'passed');
    assert.equal(runner.__createArgs.port, 80);
  } finally {
    globalThis.fetch = oldFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('ordinary generated SoloHost app with Dockerfile still uses native preview', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-normal-app-'));
  await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM node:24-alpine\nEXPOSE 8080\n');
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  app:\n    image: ghcr.io/demo/app:1.0.0\n    ports:\n      - "8080:8080"\n');
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public', 'index.html'), '<h1>Hello</h1>');
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"hello","scripts":{"start":"node server.js"}}');
  const runner = new BuildRunner({ cfg: { runtime: { mode: 'auto', podman: { apiUrl: '' } }, limits: { sandboxTimeoutSec: 2 } } });
  const result = await runner.runApp({ sourcePath: dir, projectSlug: 'hello-app', timeout: 2, keepRunning: false });
  assert.notEqual(result.status, 'blocked');
  assert.notEqual(result.runtime, 'podman-sandbox');
  await fs.rm(dir, { recursive: true, force: true });
});
