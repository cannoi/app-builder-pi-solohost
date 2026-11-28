import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateProductDepth } from '../src/jobs/product-checklist.js';
import { domainFeatureHints, professionalUiMetrics } from '../src/templates/first-run-quality.js';
import { selectRealTemplate } from '../src/templates/select-real.js';
import { professionalUiGuard } from '../src/templates/first-run-quality.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const MILK = '/tmp/milk-ana';

test('domain hints for milk tea order app', () => {
  const h = domainFeatureHints('Create a milk-tea shop app with menu and cart');
  assert.ok(h.some((x) => /cart|menu|order/i.test(x)));
  assert.ok(h.some((x) => /API coherence|name,price/i.test(x)));
});

test('bare milk-tea HTML flagged unprofessional', () => {
  const html = `<!DOCTYPE html><html><body><h1>Milk Tea Menu</h1><div id="menu-list">Loading...</div><input id="name"><button>Add</button></body></html>`;
  const m = professionalUiMetrics(html, 'app.post("/api/menu",(req,res)=>{const {id,price}=req.body})');
  assert.ok(m.issues.includes('ui_unprofessional_bare') || m.metrics.minifiedBare);
});

test('std professional template still passes depth', async () => {
  const d = await evaluateProductDepth(path.join(DIR, 'std-business-crm'), { name: 'CRM Starter', idea: 'crm' });
  assert.ok(d.ok, d.summary);
  assert.ok(!d.issues.includes('ui_unprofessional_bare'));
});

test('milk tea product fixture fails professional bar or scores lower', async () => {
  const d = await evaluateProductDepth(MILK, { name: 'Milk Tea Order Manager', idea: 'menu cart' });
  // Should not pass as high-quality first-run professional UI
  assert.ok(!d.ok || d.score < 55 || d.issues.includes('ui_unprofessional_bare') || d.issues.includes('api_ui_field_mismatch'), JSON.stringify(d));
});

test('order idea selects real non-demo template', async () => {
  const sel = await selectRealTemplate(DIR, 'milk tea shop menu and cart orders', { requireNetworkForThin: false });
  assert.ok(sel.templateId);
  assert.ok(!String(sel.templateId).includes('hello'));
});

test('professional generation guard requires EN/VI, language-matched AI chat and accessible responsive UI', () => {
  const guard = professionalUiGuard();
  assert.match(guard, /English \+ Vietnamese/i);
  assert.match(guard, /same language/i);
  assert.match(guard, /mobile breakpoint/i);
  assert.match(guard, /Do not claim a feature works/i);
});
