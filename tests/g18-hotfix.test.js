import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('G1 app-facts exports panel and builder knowledge', async () => {
  const m = await import('../src/ai/app-facts.js');
  assert.equal(typeof m.panelKnowledge, 'function');
  assert.equal(typeof m.builderKnowledge, 'function');
  assert.ok(m.coreKnowledge('en').length < 700);
});

test('G3 app asset versions match package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  const html = read('public/index.html');
  for (const a of ['styles.css', 'app.js', 'ai-panel.css', 'ai-panel.js', 'i18n.js']) {
    assert.match(html, new RegExp(`${a.replace('.', '\\.')}\\?v=${pkg.version.replace(/\./g, '\\.')}`));
  }
});

test('G4 hub-config version matches package.json', async () => {
  const pkg = JSON.parse(read('package.json'));
  const hub = await import('../src/feedback/hub-config.js');
  assert.equal(hub.version, pkg.version);
  assert.notEqual(hub.version, '0.0.0');
});

test('G4 offline adapter mentions App Builder, not Personal AI Hub', async () => {
  const adapter = (await import('../src/lib/app-adapter.cjs')).default
    || (await import('../src/lib/app-adapter.cjs'));
  const mod = await import('../src/lib/app-adapter.cjs');
  const a = mod.default || mod;
  const reply = await a.localReply('hello');
  assert.match(String(reply), /App Builder/i);
  assert.doesNotMatch(String(reply), /Personal AI Hub is the shared AI gateway/i);
});

test('G5 empty repo bootstrap exists and logs API failure detail', () => {
  const src = read('src/github/git-publisher.js');
  assert.match(src, /bootstrapEmptyRepoWithContentsApi/);
  assert.match(src, /contents\/README\.md|contents\/\.gitkeep/);
  assert.match(src, /GitHub API upload failed \(/);
});

test('G5 bootstrap runs before blobs when head is missing', () => {
  const src = read('src/github/git-publisher.js');
  const boot = src.indexOf('bootstrapEmptyRepoWithContentsApi');
  const blobs = src.indexOf("url: `${repoPath}/git/blobs`");
  assert.ok(boot > 0 && blobs > boot);
  assert.match(src, /if \(!headSha\) \{[\s\S]*bootstrapEmptyRepoWithContentsApi/);
  assert.match(src, /status\) === 409/);
});

test('G6 unified activity prefers event timeline', () => {
  const src = read('src/api/routes.js');
  assert.match(src, /Timeline only from real job events/);
  assert.match(src, /seenErr/);
  const panel = read('public/ai-panel.js');
  assert.match(panel, /Only add global jobs not already represented/);
});

test('G7 guidance no longer says Tap Build first for empty UI', () => {
  const np = read('src/runtime/native-preview.js');
  // User-facing string (not comments)
  assert.doesNotMatch(np, /: 'No UI files were found\. Tap Build first/);
  assert.match(np, /Type "continue"/);
  assert.doesNotMatch(read('src/jobs/pipeline.js'), /brief: 'Check is locked\. There is no app yet\. Tap Build first/);
});

test('G8 prompts ban native modules', () => {
  const prompts = read('src/ai/prompts.js');
  assert.match(prompts, /better-sqlite3/);
  assert.match(prompts, /node:sqlite/);
  assert.match(prompts, /node:crypto scrypt/);
});

test('G9 change report helper exists', () => {
  const src = read('src/jobs/pipeline.js');
  assert.match(src, /function formatChangeReport/);
  assert.match(src, /Dockerfile đã đổi|Dockerfile changed/);
  assert.match(src, /hoàn tác|Undo/);
});
