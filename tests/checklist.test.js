import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChecklist, evaluateChecklist, checklistNeedsRepair, formatChecklistReport } from '../src/engine/checklist.js';

test('buildChecklist returns 3-5 items', () => {
  const items = buildChecklist('đổi màu nền sang xanh');
  assert.ok(items.length >= 3 && items.length <= 5);
  assert.ok(items.every((i) => i.id && i.text && i.check));
});

test('evaluate never marks pass without running', async () => {
  const items = [{ id: 'x', text: 't', required: true, check: { type: 'manual' } }];
  const r = await evaluateChecklist(items, {});
  assert.equal(r[0].status, 'unverified');
});

test('file_contains pass/fail', async () => {
  const items = [{ id: 'c', text: 'color', required: true, check: { type: 'file_contains', pattern: /blue/ } }];
  const pass = await evaluateChecklist(items, { fileContents: { 'a.css': 'color: blue' } });
  assert.equal(pass[0].status, 'pass');
  const fail = await evaluateChecklist(items, { fileContents: { 'a.css': 'color: red' } });
  assert.equal(fail[0].status, 'fail');
  assert.equal(checklistNeedsRepair(fail), true);
});

test('format report', () => {
  const s = formatChecklistReport([{ status: 'pass', text: 'ok', detail: '' }]);
  assert.match(s, /pass/);
});
