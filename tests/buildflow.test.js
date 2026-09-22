import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('native preview runner does not expose a host Docker socket', async () => {
  const { BuildRunner } = await import('../src/docker/runner.js');
  const runner = new BuildRunner({ cfg: { limits: { sandboxTimeoutSec: 2 } }, log: { warn() {} } });
  const status = runner.status();
  assert.equal(status.engine, 'native-preview');
  assert.equal(status.socketPresent, false);
  assert.equal(status.usable, true);
});

test('generated Dockerfile remains a SoloHost build contract', async () => {
  const { dockerfileForProject } = await import('../src/docker/runner.js');
  const dockerfile = dockerfileForProject({ packageJson: { scripts: { start: 'node src/server.js' } } });
  assert.match(dockerfile, /FROM node:24-alpine/);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.doesNotMatch(dockerfile, /docker\.sock/i);
});

test('native preview command disables raw container control', async () => {
  const { BuildRunner } = await import('../src/docker/runner.js');
  const runner = new BuildRunner({ cfg: { limits: { sandboxTimeoutSec: 2 } }, log: { warn() {} } });
  const result = await runner.execSandbox({ command: 'docker ps' });
  assert.equal(result.status, 'blocked');
  assert.doesNotMatch(String(result.error), /socket/i);
});

test('container sandbox is selected when a Podman API endpoint is configured', async () => {
  const { BuildRunner } = await import('../src/docker/runner.js');
  const runner = new BuildRunner({
    cfg: { runtime: { mode: 'auto', podman: { apiUrl: 'http://sandbox:8080' } }, limits: { sandboxTimeoutSec: 2 } },
    log: { warn() {} },
  });
  const status = runner.status();
  assert.equal(status.engine, 'podman-api');
  assert.equal(status.dockerSocket, false);
  assert.equal(status.fallback, 'native-preview');
});

test('Podman sandbox runner has no host Docker socket dependency', async () => {
  const { BuildRunner } = await import('../src/docker/runner.js');
  const runner = new BuildRunner({
    cfg: { runtime: { mode: 'auto', podman: { apiUrl: 'http://sandbox:8080' } }, limits: { sandboxTimeoutSec: 2 } },
    log: { warn() {} },
  });
  const result = await runner.execSandbox({ command: 'docker ps' });
  assert.equal(result.status, 'blocked');
  assert.doesNotMatch(String(result.error), /docker\.sock/i);
});

test('native preview serves index.html and /health without Docker', async () => {
  const { NativePreview } = await import('../src/runtime/native-preview.js');
  const root = fs.mkdtempSync('/tmp/paf-native-preview-');
  fs.mkdirSync(`${root}/public`);
  fs.writeFileSync(`${root}/public/index.html`, '<html><body>Calculator</body></html>');
  const preview = new NativePreview({ cfg: {}, log: { warn() {} } });
  const result = await preview.run({ sourcePath: root, projectSlug: 'calc-preview', timeout: 10, keepRunning: true });
  assert.equal(result.status, 'passed');
  assert.equal(result.health, true);
  assert.ok(result.hostPort);
  const health = await fetch(`http://127.0.0.1:${result.hostPort}/health`);
  assert.equal(health.ok, true);
  const page = await fetch(`http://127.0.0.1:${result.hostPort}/`);
  assert.match(await page.text(), /Calculator/);
  await preview.stop({ projectSlug: 'calc-preview' });
});

test('native preview still serves UI when package.json start script crashes', async () => {
  const { NativePreview } = await import('../src/runtime/native-preview.js');
  const root = fs.mkdtempSync('/tmp/paf-native-express-');
  fs.mkdirSync(`${root}/public`);
  fs.writeFileSync(`${root}/public/index.html`, '<html><body>Snake</body></html>');
  fs.writeFileSync(`${root}/package.json`, JSON.stringify({ name: 'snake', scripts: { start: 'node server.js' }, main: 'server.js' }));
  fs.writeFileSync(`${root}/server.js`, 'process.exit(1)');
  const preview = new NativePreview({ cfg: {}, log: { warn() {} } });
  const result = await preview.run({ sourcePath: root, projectSlug: 'snake-preview', timeout: 10, keepRunning: true });
  assert.equal(result.status, 'passed');
  const page = await fetch(`http://127.0.0.1:${result.hostPort}/`);
  assert.match(await page.text(), /Snake/);
  await preview.stop({ projectSlug: 'snake-preview' });
});

test('native preview gives an accurate, actionable error for a Dockerfile-only app (no package.json, no index.html) instead of a misleading "Tap Build" message', async () => {
  const { NativePreview } = await import('../src/runtime/native-preview.js');
  const root = fs.mkdtempSync('/tmp/paf-native-dockeronly-');
  // Simulates an imported multi-process container image (e.g. a VNC/browser
  // app): no Node.js entrypoint, no static index.html — only runnable inside
  // a real container.
  fs.writeFileSync(`${root}/Dockerfile`, 'FROM alpine:3.19.1\nRUN apk add --no-cache supervisor\nENTRYPOINT ["supervisord"]\n');
  const preview = new NativePreview({ cfg: {}, log: { warn() {} } });
  const result = await preview.run({ sourcePath: root, projectSlug: 'novnc-preview', timeout: 5, keepRunning: false });
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(result.error, /Tap Build first/);
  assert.match(result.error, /Container Sandbox/);
  assert.match(result.error, /container-only app|Container Sandbox/);
});

test('native preview keeps the original "Tap Build" message for a project with neither UI files nor a Dockerfile', async () => {
  const { NativePreview } = await import('../src/runtime/native-preview.js');
  const root = fs.mkdtempSync('/tmp/paf-native-empty-');
  const preview = new NativePreview({ cfg: {}, log: { warn() {} } });
  const result = await preview.run({ sourcePath: root, projectSlug: 'empty-preview', timeout: 5, keepRunning: false });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Tap Build first/);
});

test('native preview also finds index.html in broader static-asset directory conventions', async () => {
  const { NativePreview } = await import('../src/runtime/native-preview.js');
  const root = fs.mkdtempSync('/tmp/paf-native-static-');
  fs.mkdirSync(`${root}/static`);
  fs.writeFileSync(`${root}/static/index.html`, '<html><body>Static App</body></html>');
  const preview = new NativePreview({ cfg: {}, log: { warn() {} } });
  const result = await preview.run({ sourcePath: root, projectSlug: 'static-preview', timeout: 10, keepRunning: true });
  assert.equal(result.status, 'passed');
  const page = await fetch(`http://127.0.0.1:${result.hostPort}/`);
  assert.match(await page.text(), /Static App/);
  await preview.stop({ projectSlug: 'static-preview' });
});
