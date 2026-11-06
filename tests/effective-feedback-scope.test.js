import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = fs.readFileSync(path.join(root, 'src/jobs/pipeline.js'), 'utf8');

test('effectiveFeedback is declared inside improveProject before use', () => {
  const fn = pipeline.indexOf('async function improveProject');
  assert.ok(fn > 0);
  const decl = pipeline.indexOf('let effectiveFeedback', fn);
  const use = pipeline.indexOf('effectiveFeedback', decl + 5);
  assert.ok(decl > fn, 'must declare inside improveProject');
  assert.ok(use > decl);
  // job handler must not leave a dangling reference without declaration nearby
  const job = pipeline.indexOf("jobs.on('improve'");
  const jobSlice = pipeline.slice(job, fn);
  assert.ok(!/feedback:\s*effectiveFeedback/.test(jobSlice), 'job handler must not pass undeclared effectiveFeedback');
});

test('professionalUiGuard import exists', () => {
  assert.match(pipeline, /professionalUiGuard/);
  assert.match(pipeline, /domainFeatureHints/);
});
