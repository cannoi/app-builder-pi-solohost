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

test('refined upstream templates are instantiable source', async () => {
  for (const id of ['uptime-kuma', 'filebrowser', 'homepage']) {
    const t = await getTemplateById(DIR, id);
    assert.ok(t, id);
    assert.equal(t.kind, 'source');
    assert.equal(t.instantiable, true);
    assert.ok(t.source?.url || t.attribution);
  }
});

test('monitoring query ranks uptime or monitoring std', async () => {
  const m = await matchTemplates(DIR, 'uptime monitoring dashboard status page', { limit: 10 });
  assert.ok(m.selected_template_id);
  const blob = [m.selected_template_id, m.selection_reason, ...(m.alternative_template_ids || [])].join(' ');
  assert.match(blob, /uptime|monitor|std-monitoring/i);
});

test('source instantiable count includes std + refined upstream', async () => {
  const all = await readTemplateCatalog(DIR);
  assert.ok(all.length >= 100);
  const sources = all.filter((t) => t.kind === 'source' && t.instantiable);
  assert.ok(sources.length >= 18, `got ${sources.length}`);
});
