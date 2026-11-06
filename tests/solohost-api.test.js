import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateRemote } from '../src/release/solohost-api.js';

function startMock(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('validateRemote ok', async () => {
  const { server, port } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  process.env.SOLOHOST_API = `http://127.0.0.1:${port}`;
  const r = await validateRemote({ composeYaml: 'services: {}', configOptionsYaml: 'title: x' });
  delete process.env.SOLOHOST_API;
  server.close();
  assert.equal(r.status, 'ok');
});

test('validateRemote fail', async () => {
  const { server, port } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, errors: [{ rule: 'X', message: 'bad' }] }));
  });
  process.env.SOLOHOST_API = `http://127.0.0.1:${port}`;
  const r = await validateRemote({ composeYaml: 'a', configOptionsYaml: 'b' });
  delete process.env.SOLOHOST_API;
  server.close();
  assert.equal(r.status, 'fail');
  assert.ok(r.errors.length);
});

test('validateRemote unreachable', async () => {
  process.env.SOLOHOST_API = 'http://127.0.0.1:1';
  process.env.SOLOHOST_VALIDATE_RETRIES = '1';
  process.env.SOLOHOST_VALIDATE_RETRY_MS = '10';
  const r = await validateRemote({ composeYaml: 'a', configOptionsYaml: 'b' });
  delete process.env.SOLOHOST_API;
  delete process.env.SOLOHOST_VALIDATE_RETRIES;
  delete process.env.SOLOHOST_VALIDATE_RETRY_MS;
  assert.equal(r.status, 'unreachable');
});
