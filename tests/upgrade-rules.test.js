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

test('module integration rules require SoloHost environment and safe authorization', () => {
  const feedback = parseRule(fs.readFileSync(new URL('../modules/rules/feedback.md', import.meta.url), 'utf8'));
  const kernel = parseRule(fs.readFileSync(new URL('../modules/rules/ai-kernel.md', import.meta.url), 'utf8'));
  assert.equal(feedback.valid, true, feedback.error);
  assert.equal(kernel.valid, true, kernel.error);
  assert.ok(feedback.requiredCapabilities.some((item) => /SHFH_HUB_URL.*SHFH_HUB_ID.*SHFH_INGEST_TOKEN/i.test(item)));
  assert.match(feedback.source, /config_options\.yml/);
  assert.match(feedback.source, /Do not ask app users/);
  assert.match(feedback.source, /Do not add a public unauthenticated proxy/);
  assert.ok(kernel.requiredCapabilities.some((item) => /authorized/i.test(item)));
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
  assert.match(js, /attach Rule files/i);
});

import { normalizeExecution, buildRuleTasks } from '../src/upgrade/rules.js';

test('Rule execution tolerates null or missing execution config', () => {
  const a = normalizeExecution(null);
  const b = normalizeExecution(undefined);
  assert.equal(a.maxCycles, 20);
  assert.equal(b.maxCycles, 20);
  assert.ok(a.maxTasks >= 1);
});

test('Rule parser accepts execution parameters without one-shot execution', () => {
  const rule = parseRule(`RULE_NAME: TEST_RULE\nGOAL: Complete the app\nREQUIRED_CAPABILITIES:\n- Search\n- Playback\nEXECUTION:\n  MAX_CYCLES: 12\n  MAX_TASKS: 20\n  MAX_RETRIES_PER_TASK: 1\n  AUTO_APPLY: true\nDEFINITION_OF_DONE:\n- Search returns results\n- Playback works`);
  assert.equal(rule.valid, true);
  assert.equal(rule.execution.maxCycles, 20);
  assert.equal(rule.execution.maxTasks, 20);
  assert.equal(rule.execution.autoApply, true);
  assert.equal(buildRuleTasks(rule).length, 4);
});

test('Rule engine asks AI for one task instead of the full Rule', () => {
  const js = fs.readFileSync(new URL('../src/upgrade/engine.js', import.meta.url), 'utf8');
  assert.match(js, /taskBrief/);
  assert.match(js, /ONE BUILDER TASK ONLY/);
  assert.doesNotMatch(js, /ruleText: JSON\.stringify\(\{ \.\.\.parsed/);
});

test('Rule cycles stay between 20 and 100', () => {
  const high = normalizeExecution({ maxCycles: 999 });
  const low = normalizeExecution({ maxCycles: 2 });
  assert.equal(high.maxCycles, 100);
  assert.equal(low.maxCycles, 20);
});
