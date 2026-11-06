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


test('Upgrade scope excludes Build scan, DARE, and automatic repair from the Upgrade engine', async () => {
  const engine = await fs.readFile(new URL('../src/upgrade/engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /scanProject\s*\(/);
  assert.doesNotMatch(engine, /runDare\s*\(/);
  assert.doesNotMatch(engine, /runStaticTests\s*\(/);
  assert.doesNotMatch(engine, /runNodeTests\s*\(/);
  assert.match(engine, /verifyUpgradeChanges/);
  assert.match(engine, /agent-working-memory\.json/);
});

test('Upgrade-origin Publish skips source scan/repair but still synchronizes the SoloHost package', async () => {
  const pipeline = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(pipeline, /const upgradeOrigin/);
  assert.match(pipeline, /if \(!upgradeOrigin\) \{/);
  assert.match(pipeline, /releases\.prepareSoloHost/);
  assert.match(pipeline, /upgradeOrigin \|\| attempts >= 1/);
});

test('AI Kernel knows the current Upgrade/Build/Publish boundary and package synchronization', async () => {
  const knowledge = await fs.readFile(new URL('../src/ai/knowledge.js', import.meta.url), 'utf8');
  assert.match(knowledge, /Upgrade is separate from Build/);
  assert.match(knowledge, /deployment artifact/);
  assert.match(knowledge, /config_options\.yml/);
  const prompts = await fs.readFile(new URL('../src/ai/prompts.js', import.meta.url), 'utf8');
  assert.match(prompts, /UPGRADE AGENT CONTRACT/);
  assert.match(prompts, /Source → image → SoloHost package/);
});
