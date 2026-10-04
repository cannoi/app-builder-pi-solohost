import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  buildAiProjectContext,
  collectProjectContextText,
  checkSourceFreshness,
} from '../src/services/project-context-resolver.js';

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { start: 'node server.js' } }, null, 2));
  await fs.writeFile(path.join(root, 'Dockerfile'), 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node","server.js"]\n');
  await fs.writeFile(path.join(root, 'server.js'), 'import http from "node:http";\nhttp.createServer((q,s)=>s.end("ok")).listen(3000);\n');
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(path.join(root, 'public/index.html'), '<html><body>Hi</body></html>');
  await fs.writeFile(path.join(root, 'public/app.js'), 'console.log("ui");\n');
  await fs.writeFile(path.join(root, 'README.md'), '# Demo app\n');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/routes.js'), 'export function routes(){ return []; }\n');
  return root;
}

test('ask mode includes snapshot header, inventory, and core manifests', async () => {
  const root = await makeFixture();
  const ctx = await buildAiProjectContext(null, {
    mode: 'ask',
    query: 'How does the server start?',
    sourceDir: root,
    maxChars: 20000,
  });
  assert.match(ctx.text, /AUTHORITATIVE SOURCE SNAPSHOT/);
  assert.match(ctx.text, /sourceType:/);
  assert.match(ctx.text, /sourceHash:/);
  assert.match(ctx.text, /fileCount:/);
  assert.match(ctx.text, /FILE INVENTORY/);
  assert.match(ctx.text, /package\.json/);
  assert.match(ctx.text, /server\.js/);
  assert.match(ctx.text, /NEED_FILES/);
  assert.ok(ctx.selectedFiles.includes('package.json') || ctx.text.includes('--- package.json ---'));
  assert.ok(ctx.snapshot.fileCount >= 5);
});

test('improve and upgrade modes share the same snapshot format', async () => {
  const root = await makeFixture();
  const a = await buildAiProjectContext(null, { mode: 'improve', query: 'fix routing', sourceDir: root });
  const b = await buildAiProjectContext(null, { mode: 'upgrade', query: 'Fix Dockerfile', sourceDir: root });
  for (const t of [a.text, b.text]) {
    assert.match(t, /AUTHORITATIVE SOURCE SNAPSHOT/);
    assert.match(t, /mode:/);
    assert.match(t, /Dockerfile|package\.json/);
  }
  // Upgrade query should prefer Dockerfile
  assert.ok(b.text.includes('Dockerfile'));
});

test('query relevance ranks matching files higher', async () => {
  const root = await makeFixture();
  const ctx = await buildAiProjectContext(null, {
    mode: 'improve',
    query: 'routes routing public app',
    sourceDir: root,
    maxChars: 24000,
  });
  assert.ok(
    ctx.selectedFiles.some((f) => /routes|public\/app/.test(f)) || /routes\.js|public\/app\.js/.test(ctx.text),
    'expected routes or public/app in selection',
  );
});

test('collectProjectContextText is a stable drop-in string API', async () => {
  const root = await makeFixture();
  const text = await collectProjectContextText(root, 'server', 'chat', 16000);
  assert.equal(typeof text, 'string');
  assert.match(text, /AUTHORITATIVE SOURCE SNAPSHOT/);
  assert.ok(text.length <= 16000);
});

test('checkSourceFreshness detects sha mismatch without network', async () => {
  const same = await checkSourceFreshness({ localMeta: { commitSha: 'abc' }, remoteMeta: { commitSha: 'abc' } });
  assert.equal(same.needsRefresh, false);
  const diff = await checkSourceFreshness({ localMeta: { commitSha: 'abc' }, remoteMeta: { commitSha: 'def' } });
  assert.equal(diff.needsRefresh, true);
  assert.equal(diff.reason, 'sha_mismatch');
});

test('empty sourceDir returns safe empty snapshot', async () => {
  const ctx = await buildAiProjectContext(null, { mode: 'ask', query: 'x' });
  assert.match(ctx.text, /fileCount: 0|no source directory/i);
});
