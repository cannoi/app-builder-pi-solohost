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
