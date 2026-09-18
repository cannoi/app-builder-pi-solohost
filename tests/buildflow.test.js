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

test('native preview still serves UI when package.json has a start script', async () => {
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
