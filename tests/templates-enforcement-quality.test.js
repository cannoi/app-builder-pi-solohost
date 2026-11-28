import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { evaluateProductDepth } from '../src/jobs/product-checklist.js';
import { selectRealTemplate, isDemoTemplate, isRealTemplate } from '../src/templates/select-real.js';
import { assessProjectCompleteness, runInitQualityLoop } from '../src/templates/init-loop.js';
import { getTemplateById } from '../src/templates/library.js';
import fs from 'node:fs/promises';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

test('std CRM has professional interactive first-run UI', async () => {
  const html = await fs.readFile(path.join(DIR, 'std-business-crm', 'public', 'index.html'), 'utf8');
  assert.match(html, /<form/i);
  assert.match(html, /<button/i);
  assert.match(html, /<input/i);
  assert.match(html, /fetch\(/);
  assert.doesNotMatch(html, /coming soon/i);
  const d = await evaluateProductDepth(path.join(DIR, 'std-business-crm'), { name: 'CRM Starter', idea: 'crm' });
  assert.ok(d.ok, d.summary);
  assert.ok(d.score >= 45);
});

test('demo templates blocked by policy', async () => {
  const hello = await getTemplateById(DIR, 'hello-ai-app');
  if (hello) assert.equal(isDemoTemplate(hello), true);
  const std = await getTemplateById(DIR, 'std-business-crm');
  assert.equal(isRealTemplate(std), true);
});

test('selectRealTemplate never returns demo for CRM idea', async () => {
  const sel = await selectRealTemplate(DIR, 'CRM customers pipeline tasks', { requireNetworkForThin: false });
  assert.ok(sel.templateId);
  assert.equal(isDemoTemplate(sel.template), false);
  assert.ok(String(sel.templateId).startsWith('std-') || sel.template.thinOverlay);
});

test('assess marks std usable without AI', async () => {
  const a = await assessProjectCompleteness(path.join(DIR, 'std-productivity-pm'));
  assert.ok(a.usable, JSON.stringify(a.depth));
});

test('first-run quality loop reports a blocked project when no AI is configured and baseline fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-quality-loop-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"thin"}');
  await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM node:24\n');
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public/index.html'), '<html><body><h1>Thin</h1></body></html>');
  const projects = { sourceDir: () => dir, get: (p) => p };
  const result = await runInitQualityLoop({
    project: { id: 'p', slug: 'thin' }, projects, idea: 'thin shell',
    hasAi: false, testAndMaybeFix: async () => ({ status: 'checked' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.blockedReason, /AI is not configured/i);
});
