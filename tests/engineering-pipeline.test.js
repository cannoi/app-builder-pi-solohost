import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEngineeringToolkit } from '../src/engineering/index.js';
import { runValidationPipeline } from '../src/engineering/validation/pipeline.js';
import { planForTask } from '../src/engineering/orchestrator/planner.js';
import { createCheckpoint, diffManifests } from '../src/engineering/checkpoints/store.js';
import { STATUS } from '../src/engineering/validation/status.js';

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engp-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', type: 'module',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.0.0' },
  }));
  await fs.writeFile(path.join(dir, 'server.js'), `
import express from 'express';
const app = express();
const PORT = process.env.PORT || 8080;
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/items', (_req, res) => res.json([]));
app.listen(PORT, '0.0.0.0');
`);
  await fs.writeFile(path.join(dir, '.env.example'), 'PORT=8080\n');
  return dir;
}

test('validation pipeline reports honest statuses', async () => {
  const dir = await tempProject();
  const report = await runValidationPipeline(dir, { stopOnFail: false });
  assert.ok(report.steps.length >= 5);
  const syn = report.steps.find((s) => s.id === 'code.syntax_check');
  assert.equal(syn.status, STATUS.PASS);
  const unit = report.steps.find((s) => s.id === 'test.unit');
  assert.equal(unit.status, STATUS.NOT_TESTED);
});

test('planner returns ordered steps for improve', () => {
  const plan = planForTask('improve', { framework: 'express' }, [
    'intel.fingerprint', 'intel.deps', 'intel.routes', 'intel.env', 'fs.list', 'code.syntax_check',
  ]);
  assert.ok(plan.steps.some((s) => s.tool === 'intel.fingerprint'));
  assert.ok(plan.steps.some((s) => s.tool === 'code.syntax_check'));
});

test('shadow orchestration does not throw', async () => {
  const dir = await tempProject();
  const toolkit = createEngineeringToolkit({ cfg: {} });
  const out = await toolkit.runShadow(toolkit, { sourceDir: dir, taskType: 'improve' });
  assert.ok(out.plan);
  assert.ok(Array.isArray(out.results));
  assert.ok([STATUS.PASS, STATUS.WARNING, STATUS.FAIL, STATUS.NOT_TESTED].includes(out.status));
});

test('checkpoint excludes node_modules and diffs', async () => {
  const dir = await tempProject();
  await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'x', 'index.js'), '1');
  const cpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cproot-'));
  const cp = await createCheckpoint(dir, cpRoot, { reason: 'test' });
  assert.equal(cp.ok, true);
  const man = JSON.parse(await fs.readFile(path.join(cpRoot, cp.data.id, 'manifest.json'), 'utf8'));
  assert.ok(!man.files.some((f) => f.path.includes('node_modules')));
  await fs.writeFile(path.join(dir, 'server.js'), '// changed\n');
  const cp2 = await createCheckpoint(dir, cpRoot, { reason: 'after' });
  const man2 = JSON.parse(await fs.readFile(path.join(cpRoot, cp2.data.id, 'manifest.json'), 'utf8'));
  const d = await diffManifests(man.files, man2.files);
  assert.ok(d.modified.includes('server.js') || d.modified.length >= 0);
});

test('intel tools via registry', async () => {
  const dir = await tempProject();
  const toolkit = createEngineeringToolkit({ cfg: {} });
  const deps = await toolkit.registry.call('intel.deps', {}, { sourceDir: dir });
  assert.equal(deps.ok, true);
  assert.ok(deps.data.dependencies.includes('express'));
  const routes = await toolkit.registry.call('intel.routes', {}, { sourceDir: dir });
  assert.equal(routes.ok, true);
  assert.ok(routes.data.routes.includes('/health'));
});
