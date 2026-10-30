import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichPlan, planCompleteness } from '../src/jobs/plan-enrich.js';
import { taskComplexity } from '../src/ai/hub/catalog.js';

test('enrichPlan fills screens stories acceptance', () => {
  const p = enrichPlan({ name: 'Notes' }, { name: 'Notes', core_features: ['Add a note'] }, 'note app');
  assert.ok(p.screens.length >= 2);
  assert.ok(p.user_stories.length >= 2);
  assert.ok(p.acceptance_checks.length >= 3);
  assert.equal(planCompleteness(p).ok, true);
});

test('thin plan is not complete before enrich', () => {
  assert.equal(planCompleteness({ name: 'X' }).ok, false);
});

test('taskComplexity treats plan and code as high', () => {
  assert.equal(taskComplexity('CODING'), 'high');
  assert.equal(taskComplexity('PRODUCT_PLANNING'), 'high');
  assert.equal(taskComplexity('IDEA_ANALYSIS'), 'high');
  assert.equal(taskComplexity('USER_CHAT'), 'low');
});
