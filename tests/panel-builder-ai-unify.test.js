import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http.js';
import { mountUniversalModules } from '../src/universal/mount-universal.js';
import http from 'node:http';

function mockBuilderAI({ configured = true, provider = 'gemini', model = 'gemini-x', text = null, fail = false } = {}) {
  return {
    status() {
      return {
        configured,
        primary: provider,
        gemini: provider === 'gemini',
        deepseek: provider === 'deepseek',
        geminiModel: model,
        routing: 'SELECTED',
        hub: {
          mode: 'SELECTED',
          preferredProvider: provider,
          preferredModel: model,
          connections: configured
            ? [{ id: 'c1', provider, status: 'VERIFIED', models: [model] }]
            : [],
        },
      };
    },
    async complete({ prompt, system, task }) {
      if (fail) {
        const err = new Error(`${provider} request failed`);
        err.status = 502;
        throw err;
      }
      assert.equal(task, 'USER_CHAT');
      assert.ok(system && /App Builder/i.test(system));
      return {
        text: text || `REPLY_FROM_${provider.toUpperCase()}: ${String(prompt).slice(0, 40)}`,
        provider,
        model,
      };
    },
  };
}

async function withServer(builderAI, fn) {
  const app = createApp();
  mountUniversalModules(app, {
    cfg: {
      version: '1.4.77',
      feedbackHub: { hubId: 'SHFH-CANNOI-0905428801', url: 'http://14.176.78.46:8090', appId: 'app-builder-pi-solohost' },
    },
    log: { info() {}, warn() {}, error() {} },
    builderAI,
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

async function postChat(port, message) {
  const r = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history: [], context: { surface: 'robot-panel', app: 'App Builder — Pi SoloHost' } }),
  });
  const j = await r.json();
  return { status: r.status, j };
}

test('A/B: Panel chat uses Builder AIGateway without separate panel key', async () => {
  await withServer(mockBuilderAI({ provider: 'gemini' }), async (port) => {
    const { status, j } = await postChat(port, 'Xin chào, app này là gì?');
    assert.equal(status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.source, 'builder-hub');
    assert.equal(j.provider, 'gemini');
    assert.match(j.reply, /REPLY_FROM_GEMINI/);
    assert.doesNotMatch(j.reply, /Personal AI Hub is the shared AI gateway/i);
    assert.notEqual(j.source, 'local');
  });
});

test('C: Provider identity DeepSeek', async () => {
  await withServer(mockBuilderAI({ provider: 'deepseek', model: 'deepseek-chat' }), async (port) => {
    const { j } = await postChat(port, 'hello');
    assert.equal(j.provider, 'deepseek');
    assert.match(j.reply, /REPLY_FROM_DEEPSEEK/);
  });
});

test('D: When Builder configured, never localReply', async () => {
  await withServer(mockBuilderAI({ provider: 'gemini', text: 'Real AI answer about calculator app' }), async (port) => {
    const { j } = await postChat(port, 'Tôi muốn tạo app máy tính');
    assert.equal(j.source, 'builder-hub');
    assert.equal(j.configured, true);
    assert.doesNotMatch(j.reply, /offline guide|Local guide/i);
  });
});

test('E: Offline mode when no Builder AI — App Builder identity only', async () => {
  await withServer(mockBuilderAI({ configured: false }), async (port) => {
    const { j } = await postChat(port, 'xin chào');
    assert.equal(j.source, 'local');
    assert.match(j.reply, /App Builder/i);
    assert.doesNotMatch(j.reply, /Personal AI Hub is the shared AI gateway/i);
  });
});

test('F: Error transparency when Builder AI fails', async () => {
  await withServer(mockBuilderAI({ provider: 'gemini', fail: true }), async (port) => {
    const { status, j } = await postChat(port, 'test');
    assert.equal(status, 502);
    assert.equal(j.configured, true);
    assert.match(String(j.error || j.reply), /AI unavailable|failed/i);
    assert.doesNotMatch(String(j.error || j.reply), /no active cloud/i);
  });
});

test('Status reflects Builder AI', async () => {
  await withServer(mockBuilderAI({ provider: 'gemini' }), async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/ai/status`);
    const j = await r.json();
    assert.equal(j.configured, true);
    assert.equal(j.source, 'builder-hub');
    assert.match(String(j.provider || j.settings?.provider), /gemini/i);
  });
});

test('Feedback config still safe', async () => {
  await withServer(mockBuilderAI(), async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/feedback/config`);
    const j = await r.json();
    assert.ok(j.hubId || j.appId);
    assert.doesNotMatch(JSON.stringify(j), /cannoi_/);
  });
});
