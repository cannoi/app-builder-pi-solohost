import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('Upgrade Workshop is separate from Create App and Docker image keeps only required runtime tools', async () => {
  const pipeline = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(pipeline, /jobs\.on\('upgrade_inspect'/);
  assert.match(pipeline, /jobs\.on\('upgrade_request'/);
  assert.match(pipeline, /jobs\.on\('upgrade_apply'/);
  const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /tini unzip git chromium/);
  assert.doesNotMatch(dockerfile, /git-lfs/);
  assert.doesNotMatch(dockerfile, /poppler-utils/);
  assert.doesNotMatch(dockerfile, /\bzip\b/);
});

test('Upgrade apply endpoint does not require a user approval gate', async () => {
  const routes = await fs.readFile(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /Upgrade approval is required/);
  assert.match(routes, /upgrade\/resume/);
});

test('Upgrade pipeline has a resumable job handler', async () => {
  const pipeline = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(pipeline, /jobs\.on\('upgrade_resume'/);
  assert.match(pipeline, /saved Upgrade plan/);
});
