/**
 * Runtime Orchestrator smoke tests (no network, no Chromium).
 * Run: node --test tests/runtime-orchestrator.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { detectRuntimeProfile } from '../src/runtime/runtime-orchestrator.js';

async function withTemp(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-rt-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('Runtime Orchestrator', () => {
  it('detects pure static HTML', async () => {
    await withTemp({ 'index.html': '<h1>Hello</h1>' }, async (dir) => {
      const p = await detectRuntimeProfile(dir);
      assert.equal(p.runtime_id, 'static-web');
      assert.equal(p.preview_supported, true);
      assert.ok(p.confidence > 0.9);
    });
  });

  it('detects Vite + React', async () => {
    await withTemp({
      'package.json': JSON.stringify({
        name: 'demo',
        scripts: { dev: 'vite', build: 'vite build' },
        dependencies: { react: '^18', 'react-dom': '^18' },
        devDependencies: { vite: '^5', '@vitejs/plugin-react': '^4' },
      }),
      'vite.config.js': 'export default {}',
      'index.html': '<div id="root"></div>',
    }, async (dir) => {
      const p = await detectRuntimeProfile(dir);
      assert.equal(p.runtime_id, 'vite-frontend');
      assert.equal(p.framework, 'react-vite');
      assert.equal(p.preview_supported, true);
      assert.ok(p.install_command.includes('install'));
    });
  });

  it('detects Express Node app', async () => {
    await withTemp({
      'package.json': JSON.stringify({
        name: 'api',
        scripts: { start: 'node server.js' },
        dependencies: { express: '^4' },
      }),
      'server.js': 'console.log("hi")',
    }, async (dir) => {
      const p = await detectRuntimeProfile(dir);
      assert.equal(p.runtime_id, 'nodejs');
      assert.equal(p.framework, 'express');
      assert.equal(p.preview_supported, true);
    });
  });

  it('detects container-only Dockerfile', async () => {
    await withTemp({
      'Dockerfile': 'FROM python:3.12\nCMD ["python", "app.py"]',
      'app.py': 'print("x")',
    }, async (dir) => {
      const p = await detectRuntimeProfile(dir);
      assert.equal(p.runtime_id, 'container-app');
      assert.equal(p.preview_supported, false);
      assert.equal(p.sandbox_required, true);
    });
  });

  it('detects Next.js as SSR limited', async () => {
    await withTemp({
      'package.json': JSON.stringify({
        name: 'web',
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { next: '^14', react: '^18' },
      }),
      'next.config.js': 'module.exports = {}',
    }, async (dir) => {
      const p = await detectRuntimeProfile(dir);
      assert.equal(p.runtime_id, 'ssr-framework');
      assert.equal(p.framework, 'next');
      assert.equal(p.preview_supported, false);
    });
  });
});
