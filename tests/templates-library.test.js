import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readTemplateCatalog, searchTemplates, listTemplateCategories,
  matchTemplates, getTemplateById, instantiateTemplateProject, catalogHealth,
} from '../src/templates/library.js';

const ROOT = path.resolve('.');
const TEMPLATES = path.join(ROOT, 'templates');

test('catalog preserves the upstream 146-entry type split and unique IDs', async () => {
  const items = await readTemplateCatalog(TEMPLATES);
  const health = catalogHealth(items);
  assert.equal(health.total, 146);
  assert.equal(health.uniqueIds, 146);
  assert.deepEqual(health.counts, { source: 2, package: 117, reference: 27 });
});

test('category filtering and search return actual catalog entries', async () => {
  const crm = await searchTemplates(TEMPLATES, { q: 'crm' });
  assert.ok(crm.some(x => x.id === 'twenty'));
  const cats = await listTemplateCategories(TEMPLATES, 'vi');
  assert.ok(cats.some(x => x.id === 'business-crm' && x.label.includes('Kinh doanh')));
});

test('matcher only returns IDs present in catalog and ranks CRM candidates', async () => {
  const items = await readTemplateCatalog(TEMPLATES);
  const result = await matchTemplates(TEMPLATES, 'I need a CRM to manage customers and sales leads');
  assert.ok(result.results.length > 0);
  assert.ok(items.some(x => x.id === result.results[0].template_id));
  assert.ok(result.results.some(x => x.template_id === 'twenty' || x.template_id === 'frappe-crm'));
  for (const row of result.results) assert.ok(items.some(x => x.id === row.template_id));
});

test('package and reference entries are never marked as editable source', async () => {
  const pkg = await getTemplateById(TEMPLATES, 'n8n');
  const ref = await getTemplateById(TEMPLATES, 'foundry-reference');
  assert.equal(pkg.kind, 'package');
  assert.equal(pkg.instantiable, false);
  assert.equal(ref.kind, 'reference');
  assert.equal(ref.instantiable, false);
  const internal = await getTemplateById(TEMPLATES, 'sandbox-benchmark');
  assert.equal(internal.internalOnly, true);
  assert.equal(internal.instantiable, false);
});

test('source instantiation copies an app and leaves the built-in template untouched', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-template-test-'));
  let queuedJob = null;
  const jobs = { enqueue(job) { queuedJob = job; return { id: 'job-template-1' }; } };
  const projects = {
    async create(data) {
      const project = { id: 'p-test', slug: 'test-app', name: data.name, ...data };
      await fs.mkdir(path.join(tmp, 'projects', project.slug, 'source'), { recursive: true });
      return project;
    },
    sourceDir(slug) { return path.join(tmp, 'projects', slug, 'source'); },
    async saveMetadata() {},
    async chat() {},
    setStatus() {},
  };
  try {
    const before = await fs.readFile(path.join(TEMPLATES, 'hello-ai-app', 'src', 'server.js'), 'utf8');
    const result = await instantiateTemplateProject({
      templatesDir: TEMPLATES, projects, jobs, templateId: 'hello-ai-app',
      idea: 'A small sample app', name: 'Sample App',
    });
    assert.equal(result.ok, true);
    assert.ok(result.filesWritten > 0);
    assert.equal(result.customizationQueued, true);
    assert.equal(queuedJob.type, 'improve');
    assert.equal(queuedJob.payload.feedback, 'A small sample app');
    const copied = await fs.readFile(path.join(tmp, 'projects', 'test-app', 'source', 'src', 'server.js'), 'utf8');
    assert.ok(copied.length > 0);
    assert.equal(await fs.readFile(path.join(TEMPLATES, 'hello-ai-app', 'src', 'server.js'), 'utf8'), before);
    const provenance = JSON.parse(await fs.readFile(path.join(tmp, 'projects', 'test-app', 'source', '.builder-template.json'), 'utf8'));
    assert.equal(provenance.templateId, 'hello-ai-app');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('package instantiation is rejected rather than guessing deployment details', async () => {
  const projects = { create() { throw new Error('must not create project'); } };
  await assert.rejects(
    instantiateTemplateProject({ templatesDir: TEMPLATES, projects, templateId: 'n8n', idea: 'automation' }),
    err => err.code === 'TEMPLATE_NOT_INSTANTIABLE',
  );
});
