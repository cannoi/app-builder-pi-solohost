import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeZip, readZip } from '../src/utils/zip.js';
import { isQuestion, inferAction } from '../src/scripts/ops.js';

test('zip pack and unpack round-trip without the zip CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-zip-'));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi');
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>ok</h1>');
  const zipPath = path.join(dir, 'out.zip');
  const packed = await writeZip(dir, zipPath);
  assert.ok(packed.bytes > 0);
  const dest = path.join(dir, 'out');
  fs.mkdirSync(dest);
  const names = await readZip(fs.readFileSync(zipPath), dest);
  assert.ok(names.includes('hello.txt'));
  assert.equal(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf8'), 'hi');
});

test('questions are not treated as build commands', () => {
  assert.equal(isQuestion('Làm sao lấy GitHub token?'), true);
  assert.equal(inferAction('Làm sao lấy GitHub token?'), 'reply');
  assert.equal(inferAction('Cách đăng ký app trên SoloHost?'), 'reply');
  assert.equal(inferAction('xuất bản lên github'), 'publish');
});

test('generated apps include a GitHub Actions image workflow', async () => {
  const { writeGithubWorkflow } = await import('../src/projects/generator.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-wf-'));
  await writeGithubWorkflow(dir, { slug: 'demo-app' });
  const yml = fs.readFileSync(path.join(dir, '.github/workflows/docker.yml'), 'utf8');
  assert.match(yml, /ghcr.io/);
  assert.match(yml, /docker\/build-push-action/);
  assert.match(yml, /packages:\s*write/);
  assert.match(yml, /actions\/checkout@v6/);
});

test('generated GitHub workflow publishes the exact SoloHost version tag', async () => {
  const { writeGithubWorkflow } = await import('../src/projects/generator.js');
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const dir = await fs.mkdtemp(`${os.tmpdir()}/paf-workflow-version-`);
  await writeGithubWorkflow(dir, { slug: 'demo-app', version: '0.1.7' });
  const yml = await fs.readFile(`${dir}/.github/workflows/docker.yml`, 'utf8');
  assert.match(yml, /type=raw,value=0\.1\.7/);
  assert.match(yml, /packages:\s*write/);
});

test('Windows GitHub fallback is bundled and verifies the GHCR image before SoloHost install', async () => {
  const fs = await import('node:fs/promises');
  const script = await fs.readFile(new URL('../fallback/GitHub-ZIP-Image-Publisher-v5.0.ps1', import.meta.url), 'utf8');
  assert.match(script, /GitHub ZIP -> Docker Image Publisher/);
  assert.match(script, /v5\.0/);
  assert.match(script, /ghcr\.io/);
  assert.match(script, /Git Data API/);
});

test('Builder image declares the GitHub source label used to link GHCR packages', async () => {
  const fs = await import('node:fs/promises');
  const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /org\.opencontainers\.image\.source=.*github\.com\/cannoi\/app-builder-pi-solohost/);
});

test('dynamic chat language support remains enabled', async () => {
  const { detectUserLanguage } = await import('../src/ai/language.js');
  assert.equal(detectUserLanguage('Hãy giúp tôi sửa lỗi ứng dụng'), 'Vietnamese');
  assert.equal(detectUserLanguage('帮我修复这个应用'), 'Chinese');
  assert.equal(detectUserLanguage('Please build this app'), 'English');
});


test('generated workflow builds, smoke-tests, then pushes the exact version image', async () => {
  const { writeGithubWorkflow } = await import('../src/projects/generator.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-wf-smoke-'));
  await writeGithubWorkflow(dir, { slug: 'demo-app', version: '1.4.22' });
  const yml = fs.readFileSync(path.join(dir, '.github/workflows/docker.yml'), 'utf8');
  assert.match(yml, /name: Smoke test image/);
  assert.match(yml, /load: true/);
  assert.match(yml, /docker run -d/);
  assert.match(yml, /ghcr\.io\/\$\{\{ github\.repository \}\}:1\.4\.22/);
  assert.match(yml, /name: Push image/);
});
