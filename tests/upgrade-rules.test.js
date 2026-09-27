import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRule, capabilityGap } from '../src/upgrade/rules.js';

test('parses the bundled media-center rule', () => {
  const text = fs.readFileSync(new URL('../rules/media-center.rule', import.meta.url), 'utf8');
  const rule = parseRule(text);
  assert.equal(rule.valid, true);
  assert.equal(rule.name, 'MEDIA_CENTER');
  assert.ok(rule.requiredCapabilities.includes('Playback'));
});

test('rejects a rule that embeds a live-looking secret', () => {
  const rule = parseRule('RULE_NAME: X\nGOAL: demo\nREQUIRED CAPABILITIES:\n- Chat\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(rule.valid, false);
  assert.match(rule.error, /RULE_INVALID/);
});

test('capability gap keeps missing playback when source has only search', () => {
  const rule = parseRule('RULE_NAME: MEDIA_CENTER\nGOAL: play media\nREQUIRED CAPABILITIES:\n- Search\n- Playback');
  const gap = capabilityGap(rule, 'function search() { return []; }');
  assert.deepEqual(gap.currentCapabilities, ['Search']);
  assert.deepEqual(gap.missingCapabilities, ['Playback']);
  assert.equal(gap.complete, false);
});

test('upgrade workshop accepts rule file attachments', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /ruleText/);
  assert.match(js, /attach a Rule file/);
});

import { normalizeExecution, buildRuleTasks } from '../src/upgrade/rules.js';

test('Rule execution tolerates null or missing execution config', () => {
  const a = normalizeExecution(null);
  const b = normalizeExecution(undefined);
  assert.equal(a.maxCycles, 8);
  assert.equal(b.maxCycles, 8);
  assert.ok(a.maxTasks >= 1);
});

test('Rule parser accepts execution parameters without one-shot execution', () => {
  const rule = parseRule(`RULE_NAME: TEST_RULE\nGOAL: Complete the app\nREQUIRED_CAPABILITIES:\n- Search\n- Playback\nEXECUTION:\n  MAX_CYCLES: 12\n  MAX_TASKS: 20\n  MAX_RETRIES_PER_TASK: 1\n  AUTO_APPLY: true\nDEFINITION_OF_DONE:\n- Search returns results\n- Playback works`);
  assert.equal(rule.valid, true);
  assert.equal(rule.execution.maxCycles, 12);
  assert.equal(rule.execution.maxTasks, 20);
  assert.equal(rule.execution.autoApply, true);
  assert.equal(buildRuleTasks(rule).length, 4);
});
