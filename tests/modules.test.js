import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonFileStore } from '../modules/ai-app-kernel/src/store.js';
import { runTool } from '../modules/ai-app-kernel/src/tools.js';
import { completeChat } from '../modules/ai-app-kernel/src/providers.js';
import { stageUpgradeModule, rollbackUpgradeModule } from '../src/upgrade/module-staging.js';
import { sourceFingerprint } from '../src/projects/source-version.js';

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createSnapshots(sourceDir, root) {
  const rows = new Map();
  let id = 0;
  return {
    async create(_project, reason) {
      const snapshotId = String(++id);
      const snapshotPath = path.join(root, `snapshot-${snapshotId}`);
      await fs.cp(sourceDir, snapshotPath, { recursive: true });
      rows.set(snapshotId, snapshotPath);
      return { id: snapshotId, path: snapshotPath, reason };
    },
    async restore(_project, snapshotId) {
      await fs.rm(sourceDir, { recursive: true, force: true });
      await fs.cp(rows.get(snapshotId), sourceDir, { recursive: true });
    },
  };
}

test('AI Kernel database tools enforce collection and field allowlists and filter reads', async () => {
  const store = {
    async list() { return [{ id: '1', title: 'safe', apiKey: 'never return' }]; },
    async get() { return { id: '1', title: 'safe', token: 'never return' }; },
    async put(_collection, record) { return { ...record, unexpected: 'hidden' }; },
    async delete() { return { deleted: true }; },
  };
  const schema = { name: 'test', collections: [{ name: 'notes', fields: ['id', 'title'] }, { name: 'apiTokens', fields: ['id', 'token'] }] };
  const ctx = { store, schema, actions: { invoke() {} }, ctx: {} };
  assert.deepEqual((await runTool('db_list', { collection: 'notes' }, ctx)).items, [{ id: '1', title: 'safe' }]);
  assert.deepEqual((await runTool('db_get', { collection: 'notes', id: '1' }, ctx)).item, { id: '1', title: 'safe' });
  assert.deepEqual((await runTool('db_put', { collection: 'notes', record: { title: 'updated' } }, ctx)).item, { title: 'updated' });
  await assert.rejects(runTool('db_list', { collection: 'apiTokens' }, ctx), /not in the app schema/);
  await assert.rejects(runTool('db_put', { collection: 'notes', record: { apiKey: 'x' } }, ctx), /not allowed/);
  await assert.rejects(runTool('db_list', { collection: 'notes', filter: { password: 'x' } }, ctx), /not allowed/);
});

test('AI Kernel schema output hides sensitive collections and fields', async () => {
  const out = await runTool('app_schema', {}, {
    schema: { name: 'test', collections: [{ name: 'notes', fields: ['id', 'text', 'walletKey'] }, { name: 'credentials', fields: ['id'] }] },
  });
  assert.deepEqual(out.schema, { name: 'test', collections: [{ name: 'notes', fields: ['id', 'text'] }] });
  assert.deepEqual(out.collections, ['notes']);
});

test('Gemini sends credentials in a header, never in its URL', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) };
  };
  try {
    await completeChat({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'test-secret-key', messages: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.doesNotMatch(request.url, /test-secret-key/);
  assert.equal(request.options.headers['x-goog-api-key'], 'test-secret-key');
});

test('corrupt JSON store is preserved instead of replaced with seed data', async () => {
  const dir = await tempDir('ai-kernel-store-');
  const file = path.join(dir, 'data.json');
  const original = '{"notes": [';
  await fs.writeFile(file, original);
  const store = createJsonFileStore(file, { notes: [] });
  await assert.rejects(store.listCollections(), /refusing to overwrite/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await fs.rm(dir, { recursive: true, force: true });
});

test('JSON store can atomically update an existing valid file', async () => {
  const dir = await tempDir('ai-kernel-store-write-');
  const file = path.join(dir, 'data.json');
  await fs.writeFile(file, JSON.stringify({ notes: [] }));
  const store = createJsonFileStore(file, { notes: [] });
  const item = await store.put('notes', { id: '1', title: 'saved' });
  assert.equal(item.title, 'saved');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).notes, [{ id: '1', title: 'saved' }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Feedback module asks for explicit HTTPS configuration and keeps it out of storage and URLs', async () => {
  const source = await fs.readFile(new URL('../modules/feedback/shfh-client.js', import.meta.url), 'utf8');
  const vm = await import('node:vm');
  const requests = [];
  const saved = new Map();
  const context = {
    URL,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    AbortController,
    crypto: { randomUUID: () => 'anon-test-id' },
    window: { localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, json: async () => ({ ok: true, items: [] }) };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  assert.throws(() => context.SHFH.create({ hubUrl: 'http://hub.example', hubId: 'hub', ingestToken: 'token', appId: 'app' }), /HTTPS/);
  const client = context.SHFH.create({ hubUrl: 'https://hub.example', hubId: 'hub-runtime', ingestToken: 'token-runtime', appId: 'app' });
  await client.sendFeedback({ message: 'hello', type: 'question' });
  const post = requests[0];
  assert.equal(new URL(post.url).searchParams.has('hub_id'), false);
  assert.doesNotMatch(post.url, /token-runtime/);
  assert.equal(post.options.headers.Authorization, 'Bearer token-runtime');
  const body = JSON.parse(post.options.body);
  assert.equal(body.hub_id, 'hub-runtime');
  assert.equal('license' in body, false);
  assert.ok([...saved.values()].every((value) => !String(value).includes('token-runtime')));
  assert.ok([...saved.keys()].every((key) => !String(key).includes('hub-runtime') && !String(key).includes('hub.example')));
});

test('Upgrade module staging is checkpointed, scoped, and exactly rollbackable', async () => {
  const root = await tempDir('module-stage-');
  const sourceDir = path.join(root, 'source');
  const modulesRoot = path.join(root, 'modules');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(path.join(modulesRoot, 'feedback'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'app.js'), 'current app');
  await fs.writeFile(path.join(modulesRoot, 'feedback', 'shfh-client.js'), 'module client');
  const snapshots = createSnapshots(sourceDir, root);
  const project = { id: 'test', slug: 'test' };
  const beforeHash = await sourceFingerprint(sourceDir);
  const staged = await stageUpgradeModule({ project, sourceDir, snapshots, modulesRoot, pack: 'feedback', jobId: 'test-job' });
  assert.deepEqual(staged.changedFiles.sort(), ['public/shfh-client.js', 'vendor/feedback/shfh-client.js']);
  assert.notEqual(staged.afterHash, beforeHash);
  assert.equal(await fs.readFile(path.join(sourceDir, 'public', 'shfh-client.js'), 'utf8'), 'module client');
  const rollback = await rollbackUpgradeModule({ project, sourceDir, snapshots, stage: staged, reason: 'test failure' });
  assert.equal(rollback.terminalState, 'ROLLED_BACK');
  assert.equal(await sourceFingerprint(sourceDir), beforeHash);
  await fs.rm(root, { recursive: true, force: true });
});

test('Upgrade staging does not overwrite a conflicting user module file', async () => {
  const root = await tempDir('module-conflict-');
  const sourceDir = path.join(root, 'source');
  const modulesRoot = path.join(root, 'modules');
  const target = path.join(sourceDir, 'vendor', 'feedback', 'shfh-client.js');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(path.join(modulesRoot, 'feedback'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'app.js'), 'current app');
  await fs.writeFile(target, 'user customized module');
  await fs.writeFile(path.join(modulesRoot, 'feedback', 'shfh-client.js'), 'new module');
  const snapshots = createSnapshots(sourceDir, root);
  const beforeHash = await sourceFingerprint(sourceDir);
  await assert.rejects(stageUpgradeModule({
    project: { id: 'test', slug: 'test' }, sourceDir, snapshots, modulesRoot, pack: 'feedback', jobId: 'conflict',
  }), (err) => err.code === 'NEEDS_USER_ACTION');
  assert.equal(await sourceFingerprint(sourceDir), beforeHash);
  assert.equal(await fs.readFile(target, 'utf8'), 'user customized module');
  await fs.rm(root, { recursive: true, force: true });
});

test('Upgrade staging snapshot rolls back later AI changes even when module files already matched', async () => {
  const root = await tempDir('module-stage-match-');
  const sourceDir = path.join(root, 'source');
  const modulesRoot = path.join(root, 'modules');
  const client = path.join(modulesRoot, 'feedback', 'shfh-client.js');
  const vendorTarget = path.join(sourceDir, 'vendor', 'feedback', 'shfh-client.js');
  const publicTarget = path.join(sourceDir, 'public', 'shfh-client.js');
  await fs.mkdir(path.dirname(vendorTarget), { recursive: true });
  await fs.mkdir(path.dirname(publicTarget), { recursive: true });
  await fs.mkdir(path.dirname(client), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'app.js'), 'before AI');
  await fs.writeFile(vendorTarget, 'module client');
  await fs.writeFile(publicTarget, 'module client');
  await fs.writeFile(client, 'module client');
  const snapshots = createSnapshots(sourceDir, root);
  const project = { id: 'test', slug: 'test' };
  const beforeHash = await sourceFingerprint(sourceDir);
  const staged = await stageUpgradeModule({ project, sourceDir, snapshots, modulesRoot, pack: 'feedback', jobId: 'already-matched' });
  assert.deepEqual(staged.changedFiles, []);
  await fs.writeFile(path.join(sourceDir, 'app.js'), 'AI changed this file');
  const rollback = await rollbackUpgradeModule({ project, sourceDir, snapshots, stage: staged, reason: 'validation failed' });
  assert.equal(rollback.terminalState, 'ROLLED_BACK');
  assert.equal(await sourceFingerprint(sourceDir), beforeHash);
  await fs.rm(root, { recursive: true, force: true });
});

test('Upgrade UI and API route expose only the two reviewed module packs', async () => {
  const ui = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const routes = await fs.readFile(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  const pipeline = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(ui, /data-pack="ai"/);
  assert.match(ui, /data-pack="feedback"/);
  assert.match(routes, /req\.body\?\.modulePack === 'ai' \|\| req\.body\?\.modulePack === 'feedback'/);
  assert.match(pipeline, /stageUpgradeModule\(/);
  assert.match(pipeline, /rollbackUpgradeModule\(/);
});
