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

test('rule parser supports bounded phases, questions, acceptance and cycle limits', () => {
  const rule = parseRule(`RULE_VERSION: 1.1
RULE_NAME: TEST_RULE
APP_TYPE: TEST
TARGET: PI_SOLOHOST
GOAL: Make the app usable
PHASES:
- Core feature
- Runtime verification
FUNCTIONAL ACCEPTANCE:
- Main action works
QUESTIONS:
- Which provider should be enabled?
MAX_CYCLES: 9
AUTO_REPAIR: true
REQUIRED CAPABILITIES:
- Playback
`);
  assert.equal(rule.valid, true);
  assert.equal(rule.maxCycles, 6);
  assert.equal(rule.phases.length, 2);
  assert.equal(rule.questions.length, 1);
  assert.equal(rule.functionalTests.length, 1);
  assert.equal(rule.autoRepair, true);
});

test('accepts extra custom rule fields without failing', () => {
  const rule = parseRule('RULE_NAME: CUSTOM\nGOAL: keep extra fields\nREQUIRED CAPABILITIES:\n- Chat\nTHEME: dark\nLOCALE: vi');
  assert.equal(rule.valid, true);
  assert.equal(rule.extras.THEME, 'dark');
  assert.equal(rule.extras.LOCALE, 'vi');
});

test('rule without explicit GOAL still parses when capabilities exist', () => {
  const rule = parseRule('RULE_NAME: MINIMAL\nREQUIRED CAPABILITIES:\n- Chat');
  assert.equal(rule.valid, true);
  assert.equal(rule.goal, 'MINIMAL');
});

test('rule upgrades skip the Apply button when auto-applied', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /result\.autoApplied/);
  assert.match(js, /Rule upgrade applied automatically/);
});

test('bounded rule execution is not entered when no rule exists', () => {
  const js = fs.readFileSync(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(js, /if \(rule && rule\.autoRepair !== false\)/);
  assert.match(js, /if \(!rule \|\| typeof rule !== 'object'\)/);
});
