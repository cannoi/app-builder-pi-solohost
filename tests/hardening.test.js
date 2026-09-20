import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { flattenImportedTree } from '../src/projects/importer.js';

test('SoloHost compose has no undeclared interpolation and no forbidden security_opt', () => {
  const y = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(y, /\$\{PREVIEW_MODE\}|\$\{PODMAN_API_URL\}/);
  assert.doesNotMatch(y, /security_opt\s*:/);
});

test('import flatten removes a single wrapper directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-import-'));
  fs.mkdirSync(path.join(root, 'wrapper'));
  fs.writeFileSync(path.join(root, 'wrapper', 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'wrapper', 'public'));
  fs.writeFileSync(path.join(root, 'wrapper', 'public', 'index.html'), 'ok');
  await flattenImportedTree(root);
  assert.ok(fs.existsSync(path.join(root, 'package.json')));
  assert.ok(fs.existsSync(path.join(root, 'public', 'index.html')));
  assert.equal(fs.existsSync(path.join(root, 'wrapper')), false);
});

test('preview uses a project-aware back link and proxy target', () => {
  const src = fs.readFileSync(new URL('../src/preview.js', import.meta.url), 'utf8');
  assert.match(src, /runtime\.proxyHost \|\| runtime\.containerIp/);
  assert.match(src, /builderHome\(project\)/);
  assert.match(src, /x-frame-options/);
});

test('AI hard contract is present in the system prompt', async () => {
  const { SYSTEM } = await import('../src/ai/prompts.js');
  for (const phrase of ['Preserve working code', 'Diagnose from actual source/log/runtime evidence', 'Create a checkpoint', 'Work in ordered atomic steps', 'Never request or mount docker.sock', 'Preview networking is ONLINE by default']) {
    assert.match(SYSTEM, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Gemini selection prefers highest available version >= 2.5', async () => {
  const { compareGeminiModels } = await import('../src/ai/providers/gemini.js');
  assert.ok(compareGeminiModels('gemini-3.5-flash', 'gemini-2.5-pro') < 0);
  assert.ok(compareGeminiModels('gemini-2.5-flash', 'gemini-2.5-pro') > 0);
});


test('ZIP import replacement removes stale source files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-import-replace-'));
  fs.mkdirSync(path.join(root, 'old'), { recursive: true });
  fs.writeFileSync(path.join(root, 'old', 'stale.txt'), 'stale');
  const { importZipBuffer } = await import('../src/projects/importer.js');
  const { writeZip } = await import('../src/utils/zip.js');
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-zip-src-'));
  fs.writeFileSync(path.join(src, 'package.json'), '{}');
  fs.mkdirSync(path.join(src, 'public'));
  fs.writeFileSync(path.join(src, 'public', 'index.html'), '<h1>new</h1>');
  const zip = path.join(os.tmpdir(), `paf-${Date.now()}.zip`);
  await writeZip(src, zip);
  await importZipBuffer(fs.readFileSync(zip), root, { replace: true });
  assert.equal(fs.existsSync(path.join(root, 'old', 'stale.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true);
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('Gemini rotates off a 503 overloaded model', async () => {
  const { geminiShouldRotate } = await import('../src/ai/providers/gemini.js');
  assert.equal(geminiShouldRotate(new Error('Gemini HTTP 503: high demand')), true);
  assert.equal(geminiShouldRotate(new Error('Gemini HTTP 200')), false);
});

test('sandbox benchmark template is bundled', () => {
  const root = new URL('../templates/sandbox-benchmark/', import.meta.url);
  assert.equal(fs.existsSync(new URL('server.js', root)), true);
  assert.equal(fs.existsSync(new URL('public/index.html', root)), true);
});

test('describeFailure includes a copy-for-AI block and a fix', async () => {
  const { describeFailure } = await import('../src/scripts/ops.js');
  const card = describeFailure({ error: 'Cannot find module \'express\'', action: 'run' });
  assert.match(card.copy, /APP BUILDER ERROR REPORT/);
  assert.match(card.fix, /./);
  assert.equal(card.code, 'missing_express');
});

test('security scan returns exact root cause, concrete fix, and copy-for-AI report', async () => {
  const { scanProject } = await import('../src/security/scanner.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-security-report-'));
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n  app:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n');
  const scan = await scanProject(root);
  assert.equal(scan.status, 'BLOCK');
  assert.equal(scan.critical, 1);
  assert.match(scan.findings[0].title, /Docker socket/i);
  assert.match(scan.findings[0].fix, /Remove the docker\.sock/i);
  assert.match(scan.copy_for_ai, /ROOT_CAUSE:/);
  assert.match(scan.copy_for_ai, /FIX:/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('security requests route to repair when user asks to fix them', async () => {
  const { inferAction } = await import('../src/scripts/ops.js');
  assert.equal(inferAction('fix security issue'), 'improve');
  assert.equal(inferAction('sửa lỗi bảo mật'), 'improve');
  assert.equal(inferAction('security scan'), 'analyze');
});

test('native preview has mandatory online verification in product config', async () => {
  const { loadConfig } = await import('../src/config/loader.js');
  const cfg = loadConfig();
  assert.equal(cfg.preview.requireInternet, true);
  assert.equal(cfg.preview.requireBrowserTest, true);
});


test('SoloHost config schema keeps fields and fixed_values as arrays', () => {
  const text = fs.readFileSync(new URL('../config_options.yml', import.meta.url), 'utf8');
  assert.match(text, /fields:\n\s+- name:/);
  assert.match(text, /fixed_values:\n\s+- name: PREVIEW_MODE/);
  assert.match(text, /- name: PODMAN_API_URL/);
});


test('queue exposes the current running job for duplicate-action recovery', async () => {
  const src = readFileSync(path.join(ROOT, 'src/jobs/queue.js'), 'utf8');
  assert.match(src, /runningJob\(projectId = null\)/);
  assert.match(src, /status IN \('queued','running'\)/);
});

test('Builder never equates browser page success with Internet verification', async () => {
  const src = readFileSync(path.join(ROOT, 'src/jobs/pipeline.js'), 'utf8');
  assert.match(src, /Internet browsing is not yet verified/);
  assert.match(src, /runtime\.internet\?\.ok === true/);
});

test('network repair prompt traces the real proxy request path', async () => {
  const src = readFileSync(path.join(ROOT, 'src/ai/prompts.js'), 'utf8');
  assert.match(src, /browser URL → app route → target URL parsing/);
  assert.match(src, /Do not merely describe a fix/);
  assert.match(src, /Never call a passing \/health or page-load check proof that Internet browsing works/);
});
