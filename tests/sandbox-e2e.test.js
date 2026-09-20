import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PodmanClient } from '../src/sandbox/podman.js';
import { runPlaywrightE2E, e2eResult } from '../src/testing/playwright.js';

test('Podman client uses HTTP API endpoint and never requires Docker socket', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({ Id: 'ctr-123', Config: { Image: 'app:test' }, State: { Running: true }, NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '43123' }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new PodmanClient({ baseUrl: 'http://podman:8080', fetchImpl });
  const info = await client.inspectContainer('ctr-123');
  assert.equal(info.Id, 'ctr-123');
  assert.equal(calls[0][0], 'http://podman:8080/v1.40/containers/ctr-123/json');
  assert.equal(calls[0][1].headers['X-App-Builder-Engine'], 'podman-api');
  assert.doesNotMatch(JSON.stringify(calls), /docker\.sock/i);
});

test('Image export explicitly requests Docker archive format', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const tar = Buffer.from('fake-tar');
    return new Response(tar, { status: 200 });
  };
  const client = new PodmanClient({ baseUrl: 'http://podman:8080', fetchImpl });
  // The HTTP contract is the important part; the runner performs the final manifest check.
  const out = await client.exportImage('app:test', '/tmp/paf-test-image.tar');
  assert.equal(out.format, 'docker-archive');
  assert.match(calls[0], /libpod\/images\/app%3Atest\/get\?format=docker-archive&compress=false$/);
});

test('Podman preview provisioning returns an isolated published port contract', async () => {
  const requests = [];
  const responses = [
    { id: 'ctr-1' },
    {},
    {},
    { NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '43124' }] } }, State: { Running: true } },
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push([url, options]);
    const body = responses.shift() || {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new PodmanClient({ baseUrl: 'http://podman:8080', fetchImpl });
  const created = await client.createPreviewContainer({ image: 'app:test', name: 'paf-app-demo' });
  assert.equal(created.id, 'ctr-1');
  assert.match(requests[0][0], /\/v1\.40\/containers\/create$/);
  assert.equal(requests[0][1].method, 'POST');
  assert.match(requests[0][1].body, /paf-app-demo/);
  assert.match(requests[0][1].body, /no-new-privileges:true/);
  assert.match(requests[0][1].body, /CapDrop/);
});

test('Playwright E2E returns the required raw JSON shape', async () => {
  const browser = {
    async newPage() {
      return {
        async goto() {},
        async title() { return 'Demo App'; },
        async screenshot() {},
        async close() {},
      };
    },
    async close() {},
  };
  const result = await runPlaywrightE2E({
    uiUrl: 'https://preview-demo.example.com',
    browserFactory: async () => browser,
  });
  assert.deepEqual(result, {
    status: 'passed',
    ui_url: 'https://preview-demo.example.com',
    test_metrics: { page_title: 'Demo App', load_time_ms: result.test_metrics.load_time_ms },
    error: null,
  });
  assert.equal(Object.keys(e2eResult(result)).sort().join(','), 'error,status,test_metrics,ui_url');
});

test('Playwright E2E surfaces navigation errors without hiding them', async () => {
  const browser = {
    async newPage() {
      return {
        async goto() { throw new Error('preview unavailable'); },
        async close() {},
      };
    },
    async close() {},
  };
  const result = await runPlaywrightE2E({ uiUrl: 'http://127.0.0.1:1', browserFactory: async () => browser });
  assert.equal(result.status, 'failed');
  assert.equal(result.ui_url, 'http://127.0.0.1:1');
  assert.match(result.error, /preview unavailable/);
  assert.equal(result.test_metrics.page_title, '');
});

test('Sandbox E2E Agent returns only the specified JSON contract and tears down', async () => {
  const calls = [];
  const podman = {
    async createPreviewContainer() { calls.push('create'); return { Id: 'ctr-9' }; },
    async startContainer() { calls.push('start'); },
    async inspectContainer() { return { NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '43125' }] } } }; },
    async stopContainer() { calls.push('stop'); },
    async removeContainer() { calls.push('remove'); },
  };
  const { runSandboxE2E } = await import('../src/sandbox/e2e-agent.js');
  const browser = { async newPage() { return { async goto() {}, async title() { return 'Preview'; }, async screenshot() {}, async close() {} }; }, async close() {} };
  const result = await runSandboxE2E({ podman, image: 'app:test', appId: 'demo', previewBaseUrl: 'https://preview.example.com', browserFactory: async () => browser, timeoutSec: 1 });
  assert.deepEqual(Object.keys(result).sort(), ['error', 'status', 'test_metrics', 'ui_url']);
  assert.equal(result.status, 'passed');
  assert.equal(result.ui_url, 'https://preview.example.com/preview-demo');
  assert.deepEqual(calls, ['create', 'start', 'stop', 'remove']);
});


test('sandbox benchmark includes deterministic Internet and DNS test', async () => {
  const file = await fs.readFile(new URL('../templates/sandbox-benchmark/server.js', import.meta.url), 'utf8');
  assert.match(file, /\/api\/internet-test/);
  assert.match(file, /DNS_UNAVAILABLE/);
  assert.match(file, /DNS_OK_BUT_HTTPS_BLOCKED/);
  const ui = await fs.readFile(new URL('../templates/sandbox-benchmark/public/index.html', import.meta.url), 'utf8');
  assert.match(ui, /Sandbox Internet \+ DNS/);
});
