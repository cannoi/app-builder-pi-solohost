import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BuildRunner } from '../src/docker/runner.js';
import { dockerStatus } from '../src/docker/modes.js';

const cfg = { docker: { mode: 'safe' }, limits: { buildTimeoutSec: 2, sandboxTimeoutSec: 2 } };

test('factory defaults to open UI bind, DeepSeek, and Docker power mode', () => {
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../templates/hello-ai-app/src/server.js', import.meta.url), 'utf8');
  const dockerfile = fs.readFileSync(new URL('../templates/hello-ai-app/Dockerfile', import.meta.url), 'utf8');
  assert.match(env, /^FACTORY_BIND=0\.0\.0\.0$/m);
  assert.match(env, /^AI_PROVIDER=deepseek$/m);
  assert.match(env, /^DOCKER_MODE=power$/m);
  assert.match(server, /process\.env\.PORT \|\| 8080/);
  assert.match(server, /process\.env\.BIND \|\| '0\.0\.0\.0'/);
  assert.match(dockerfile, /EXPOSE 8080/);
});

test('safe mode never exposes a usable host Docker runner', () => {
  const runner = new BuildRunner({ cfg, log: { warn() {}, error() {} } });
  assert.equal(runner.status().usable, false);
  assert.equal(dockerStatus('safe').mode, 'safe');
});

test('safe mode run reports explicit Docker permission requirement', async () => {
  const runner = new BuildRunner({ cfg, log: { warn() {}, error() {} } });
  const result = await runner.runApp({ projectSlug: 'demo', sourcePath: '.', confirm: true });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /POWER|Docker/i);
});

test('AI question contract is simple and actionable', async () => {
  const { ideaPrompt } = await import('../src/ai/prompts.js');
  const prompt = ideaPrompt('A subscription app');
  assert.match(prompt, /questions/);
  assert.match(prompt, /options/);
});

test('project manager supports waiting for user input', async () => {
  const { ProjectManager } = await import('../src/projects/manager.js');
  const { openDb } = await import('../src/storage/db.js');
  const { mkdtemp } = await import('node:fs/promises');
  const root = await mkdtemp('/tmp/paf-project-');
  const db = openDb(root);
  const manager = new ProjectManager({
    cfg: { projectsDir: root, ai: { provider: 'gemini' }, docker: { mode: 'safe' }, limits: { maxProjectSizeMb: 10 } },
    db, log: { warn() {} }, snapshots: {},
  });
  const project = await manager.create({ idea: 'Test', name: 'Test' });
  const changed = manager.setStatus(project, 'WAITING_INPUT');
  assert.equal(changed.status, 'WAITING_INPUT');
  db.close();
});

test('buildImage creates a minimal Dockerfile when a Node project has none', async () => {
  const { BuildRunner, dockerfileForProject } = await import('../src/docker/runner.js');
  const root = fs.mkdtempSync('/tmp/paf-build-missing-dockerfile-');
  fs.writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { start: 'node src/server.js' } }));
  fs.mkdirSync(`${root}/src`);
  fs.writeFileSync(`${root}/src/server.js`, 'console.log("ok")');
  assert.match(dockerfileForProject({ packageJson: { scripts: { start: 'node src/server.js' } }, files: ['package.json', 'src/server.js'] }), /FROM node:24-alpine/);
  const runner = new BuildRunner({ cfg: { docker: { mode: 'safe' } }, log: { warn() {}, error() {} } });
  const result = await runner.ensureBuildFiles(root);
  assert.equal(result.created, true);
  assert.match(fs.readFileSync(`${root}/Dockerfile`, 'utf8'), /EXPOSE 8080/);
});

test('buildImage verifies that the Docker image exists after docker build', async () => {
  const { BuildRunner } = await import('../src/docker/runner.js');
  const calls = [];
  const fakeExec = async (file, args) => {
    calls.push([file, args]);
    if (args[0] === 'build') return { stdout: 'Successfully tagged paf-app:demo\n', stderr: '' };
    if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{"Id":"sha256:demo"}]\n', stderr: '' };
    throw new Error(`unexpected docker call: ${file} ${args.join(' ')}`);
  };
  fs.writeFileSync('/tmp/Dockerfile', 'FROM node:24-alpine\nEXPOSE 8080\n');
  fs.writeFileSync('/tmp/Dockerfile', 'FROM node:24-alpine\nEXPOSE 8080\n');
  const runner = new BuildRunner({ cfg: { docker: { mode: 'power' }, limits: { buildTimeoutSec: 2 } }, log: { warn() {}, error() {} }, exec: fakeExec });
  runner.status = () => ({ mode: 'power', socketPresent: true, usable: true });
  const result = await runner.buildImage({ sourcePath: '/tmp', projectSlug: 'demo', timeout: 2 });
  assert.equal(result.status, 'passed');
  assert.equal(result.image, 'paf-app:demo');
  assert.equal(result.imageId, 'sha256:demo');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1].slice(0, 3), ['image', 'inspect', 'paf-app:demo']);
});

test('buildImage fails if docker build exits successfully but the image cannot be inspected', async () => {
  const { BuildRunner } = await import('../src/docker/runner.js');
  const fakeExec = async (_file, args) => {
    if (args[0] === 'build') return { stdout: 'build output', stderr: '' };
    throw Object.assign(new Error('No such image'), { stderr: 'Error: No such image: paf-app:demo' });
  };
  const runner = new BuildRunner({ cfg: { docker: { mode: 'power' }, limits: { buildTimeoutSec: 2 } }, log: { warn() {}, error() {} }, exec: fakeExec });
  runner.status = () => ({ mode: 'power', socketPresent: true, usable: true });
  const result = await runner.buildImage({ sourcePath: '/tmp', projectSlug: 'demo', timeout: 2 });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /No such image/);
});

test('runApp rejects a supplied image that is not present locally before starting a container', async () => {
  const { BuildRunner } = await import('../src/docker/runner.js');
  const calls = [];
  const fakeExec = async (file, args) => {
    calls.push([file, args]);
    if (args[0] === 'image' && args[1] === 'inspect') throw Object.assign(new Error('missing'), { stderr: 'No such image: paf-app:demo' });
    return { stdout: '', stderr: '' };
  };
  const runner = new BuildRunner({ cfg: { docker: { mode: 'power' } }, log: { warn() {}, error() {} }, exec: fakeExec });
  runner.status = () => ({ mode: 'power', socketPresent: true, usable: true });
  runner.stopApp = async () => ({ status: 'stopped' });
  const result = await runner.runApp({ sourcePath: '/tmp/paf-e2e-project/source', projectSlug: 'demo', image: 'paf-app:demo', timeout: 1 });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /No such image/);
  assert.equal(calls.filter(([, args]) => args[0] === 'run').length, 0);
});


test('runApp performs browser E2E inside the Docker sandbox before reporting success', async () => {
  const { BuildRunner } = await import('../src/docker/runner.js');
  const calls = [];
  const fakeExec = async (_file, args) => {
    calls.push(args);
    if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{"Id":"sha256:demo"}]\n', stderr: '' };
    if (args[0] === 'run') return { stdout: 'container-id\n', stderr: '' };
    if (args[0] === 'port') return { stdout: '8080/tcp -> 127.0.0.1:49152\n', stderr: '' };
    if (args[0] === 'inspect' && args[1] === '-f') return { stdout: '172.17.0.9\n', stderr: '' };
    if (args[0] === 'rm') return { stdout: '', stderr: '' };
    if (args[0] === 'ps') return { stdout: '', stderr: '' };
    if (args[0] === 'rmi') return { stdout: '', stderr: '' };
    if (args[0] === 'logs') return { stdout: 'ok\n', stderr: '' };
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  const browserFactory = async () => ({
    newPage: async () => ({
      goto: async () => {},
      title: async () => 'Demo App',
      screenshot: async () => {},
      close: async () => {},
    }),
    close: async () => {},
  });
  const runner = new BuildRunner({
    cfg: { docker: { mode: 'power' }, limits: { buildTimeoutSec: 2 } },
    log: { warn() {}, error() {} },
    exec: fakeExec,
    browserFactory,
  });
  runner.status = () => ({ mode: 'power', socketPresent: true, usable: true });
  runner.stopApp = async () => ({ status: 'stopped' });
  runner.waitForHealth = async () => ({ ok: true });
  runner.logs = async () => 'ok';
  runner.hostPort = async () => 49152;
  runner.containerIp = async () => '172.17.0.9';
  fs.mkdirSync('/tmp/paf-e2e-project/source', { recursive: true });
  const result = await runner.runApp({ sourcePath: '/tmp/paf-e2e-project/source', projectSlug: 'demo', image: 'paf-app:demo', timeout: 2 });
  assert.equal(result.status, 'passed');
  assert.equal(result.e2e.status, 'success');
  assert.equal(result.e2e.test_metrics.page_title, 'Demo App');
});

test('BuildRunner exports docker save as exportImage', () => {
  assert.equal(typeof BuildRunner.prototype.exportImage, 'function');
  assert.equal(typeof BuildRunner.prototype.pushImage, 'function');
  assert.equal(typeof BuildRunner.prototype.runApp, 'function');
});
