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
