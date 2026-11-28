/**
 * Rule 0.2 parity: ENGINEERING_TOOLKIT=off keeps the pre-toolkit (v1.8.46) behaviour:
 * no toolkit routes, no shadow work, no controlled executor (legacy execFile path), no prompt evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function project() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node t.js' } }));
  await fs.writeFile(path.join(dir, 't.js'), "console.log('ok');\n");
  return dir;
}

async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('off: Builder tests run through the legacy path (no controlled-executor audit entry)', async () => {
  const { runNodeTests } = await import('../src/testing/engine.js');
  const audit = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-off-'));
  const r = await withEnv({ ENGINEERING_TOOLKIT: 'off', ENGINEERING_AUDIT_DIR: audit }, async () => runNodeTests(await project(), 60_000));
  assert.notEqual(r.status, 'failed');
  await assert.rejects(fs.access(path.join(audit, 'engineering-audit.jsonl')));
});

test('shadow: the same tests go through the controlled executor (audited)', async () => {
  const { runNodeTests } = await import('../src/testing/engine.js');
  const audit = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-on-'));
  const r = await withEnv({ ENGINEERING_TOOLKIT: 'shadow', ENGINEERING_AUDIT_DIR: audit }, async () => runNodeTests(await project(), 60_000));
  assert.notEqual(r.status, 'failed');
  const lines = (await fs.readFile(path.join(audit, 'engineering-audit.jsonl'), 'utf8')).trim().split('\n');
  assert.ok(lines.length >= 1);
});

test('off: no /api/engineering routes are registered', async () => {
  const { registerRoutes } = await import('../src/api/routes.js');
  const { createEngineeringToolkit } = await import('../src/engineering/index.js');
  const paths = [];
  const r = new Proxy({}, { get: (_t, method) => (p) => { if (typeof p === 'string') paths.push(`${String(method)} ${p}`); } });
  const app = {
    cfg: { templatesDir: '/nonexistent', ai: {}, limits: {}, runtime: {} },
    db: {}, jobs: { isBusy: () => false }, projects: {}, snapshots: {}, github: { configured: () => false }, releases: {}, runner: {}, ai: {},
    engineering: await withEnv({ ENGINEERING_TOOLKIT: 'off' }, async () => createEngineeringToolkit({ cfg: {} })),
  };
  try { registerRoutes(r, app); } catch { /* unrelated route setup may need more context; we only inspect what got registered */ }
  assert.ok(paths.length > 10, 'core routes registered');
  assert.equal(paths.filter((p) => p.includes('/api/engineering')).length, 0);
});

test('off: shadow hook and evidence are no-ops', async () => {
  const { shadowInspect } = await import('../src/engineering/hooks.js');
  const { evidenceBlockFor } = await import('../src/engineering/evidence.js');
  const { createEngineeringToolkit } = await import('../src/engineering/index.js');
  await withEnv({ ENGINEERING_TOOLKIT: 'off' }, async () => {
    const tk = createEngineeringToolkit({ cfg: {} });
    assert.equal(tk.enabled, false);
    assert.equal(tk.active, false);
    assert.equal(await shadowInspect({ engineering: tk, projects: { sourceDir: () => '/x' } }, { project: { slug: 'x' } }), null);
    assert.equal(await evidenceBlockFor({ sourceDir: await project() }), '');
  });
});
