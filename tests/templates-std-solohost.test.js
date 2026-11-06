import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readTemplateCatalog,
  matchTemplates,
  getTemplateById,
} from '../src/templates/library.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

test('catalog includes at least 15 standard SoloHost source templates', async () => {
  const items = await readTemplateCatalog(DIR);
  const std = items.filter((t) => String(t.id).startsWith('std-') && t.kind === 'source' && t.instantiable);
  assert.ok(std.length >= 15, `got ${std.length}`);
});

test('CRM natural language maps to instantiable std-business-crm', async () => {
  const m = await matchTemplates(DIR, 'Build me a CRM with customers and sales pipeline', { limit: 8 });
  assert.ok(m.selected_template_id, 'expected selection');
  assert.equal(m.selected.instantiable, true);
  assert.match(m.selected_template_id, /std-business-crm|hello-ai|crm/i);
});

test('each std template has SoloHost-ish files on disk', async () => {
  const items = await readTemplateCatalog(DIR);
  const std = items.filter((t) => String(t.id).startsWith('std-'));
  for (const t of std) {
    const full = await getTemplateById(DIR, t.id);
    assert.ok(full.instantiable, t.id);
    const dir = path.join(DIR, full.source.path || full.id);
    const fs = await import('node:fs/promises');
    await fs.access(path.join(dir, 'src/server.js'));
    await fs.access(path.join(dir, 'Dockerfile'));
    await fs.access(path.join(dir, 'config_options.yml'));
  }
});
