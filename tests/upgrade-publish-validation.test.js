import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateReleaseProject } from '../src/github/git-publisher.js';

async function tmpProject({ dockerfile, compose } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-pubval-'));
  await fs.writeFile(
    path.join(root, 'Dockerfile'),
    dockerfile || 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node","index.js"]\n',
  );
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    compose || 'services:\n  app:\n    image: ghcr.io/demo/app:1\n    ports:\n      - "8080:8080"\n',
  );
  await fs.writeFile(path.join(root, 'index.js'), 'console.log("ok")\n');
  return root;
}

test('Dockerfile comment mentioning docker.sock does not block publish', async () => {
  const root = await tmpProject({
    dockerfile: `# Do not mount docker.sock in SoloHost packages.\nFROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node","index.js"]\n`,
  });
  const v = await validateReleaseProject(root, { context: 'source', upgradeOrigin: true });
  assert.equal(v.ok, true, v.errors?.join('; '));
  assert.ok(!v.errors?.some((e) => /Docker socket/i.test(e)));
  await fs.rm(root, { recursive: true, force: true });
});

test('Upgrade origin does not block on scanner critical alone', async () => {
  const root = await tmpProject({
    dockerfile: 'FROM node:22-alpine\n# docker.sock is forbidden on SoloHost\nWORKDIR /app\nCOPY . .\nCMD ["node","server.js"]\n',
  });
  // Add a doc that often triggers scanner notices/criticals in real apps
  await fs.writeFile(path.join(root, 'README.md'), 'Example API_KEY=sk-example-not-real\n');
  const v = await validateReleaseProject(root, { context: 'source', upgradeOrigin: true });
  assert.equal(v.ok, true, v.errors?.join('; '));
  await fs.rm(root, { recursive: true, force: true });
});

test('Real docker.sock VOLUME in Dockerfile still blocks', async () => {
  const root = await tmpProject({
    dockerfile: 'FROM node:22-alpine\nVOLUME ["/var/run/docker.sock"]\nCMD ["node","index.js"]\n',
  });
  const v = await validateReleaseProject(root, { context: 'source', upgradeOrigin: false });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Docker socket/i.test(e)));
  await fs.rm(root, { recursive: true, force: true });
});

test('publish.js passes upgradeOrigin into validation', async () => {
  const text = await fs.readFile(new URL('../src/github/publish.js', import.meta.url), 'utf8');
  assert.match(text, /upgradeOrigin:\s*Boolean\(upgradeOrigin\)/);
  assert.match(text, /upgradeOrigin\s*=\s*false/);
});
