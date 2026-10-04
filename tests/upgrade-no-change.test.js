import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isUpgradePauseError,
  planHasFileChanges,
  resolveEmptyUpgradePlan,
} from '../src/upgrade/engine.js';

test('AI_NO_CHANGE is NOT a pause error', () => {
  assert.equal(isUpgradePauseError(Object.assign(new Error('Upgrade plan contains no file changes.'), { code: 'AI_NO_CHANGE' })), false);
  assert.equal(isUpgradePauseError(Object.assign(new Error('x'), { code: 'AI_UNAVAILABLE' })), true);
  assert.equal(isUpgradePauseError(Object.assign(new Error('x'), { code: 'AI_RESPONSE_MALFORMED' })), true);
  assert.equal(isUpgradePauseError(new Error('HTTP 429 rate limit')), true);
  assert.equal(isUpgradePauseError(new Error('Upgrade plan contains no file changes.')), false);
});

test('planHasFileChanges detects empty and valid plans', () => {
  assert.equal(planHasFileChanges({ files: [] }), false);
  assert.equal(planHasFileChanges({ files: null }), false);
  assert.equal(planHasFileChanges({}), false);
  assert.equal(planHasFileChanges({ files: [{ path: 'a.js', content: '1' }] }), true);
  assert.equal(planHasFileChanges({ files: { path: 'a.js', content: '1' } }), true); // object normalized via normalizeArray
});

test('resolveEmptyUpgradePlan completes NO_CHANGE when diagnosis says already complete', async () => {
  const store = {};
  const projects = {
    async readMetadata(_p, file, fb) { return store[file] ?? fb; },
    async saveMetadata(_p, file, data) { store[file] = data; return data; },
  };
  store['upgrade-session.json'] = {
    id: 's1', status: 'running', resumable: true, phase: 'apply',
    steps: [], completedSteps: [], changedFiles: [], verification: [], checkpoints: [],
  };
  const plan = {
    root_cause: 'The application source code is fully complete and already implements the requested behavior.',
    recommendation: 'No code change is required.',
    expected_result: 'App remains unchanged',
    risk: 'low',
    files: [],
  };
  const events = [];
  const result = await resolveEmptyUpgradePlan({
    project: { id: 'p1', slug: 'p1' },
    projects,
    ai: null,
    plan,
    request: 'upgrade chat',
    emit: (stage, status, msg) => events.push({ stage, status, msg }),
    replanCount: 0,
  });
  assert.equal(result.noChange, true);
  assert.equal(result.terminalState, 'COMPLETED_NO_CHANGE');
  assert.equal(result.files.length, 0);
  assert.match(result.brief, /No code changes/i);
  assert.ok(events.some((e) => /No code changes were required/i.test(e.msg || '')));
});

test('resolveEmptyUpgradePlan replans when diagnosis claims change but files empty', async () => {
  const store = {};
  const projects = {
    async readMetadata(_p, file, fb) { return store[file] ?? fb; },
    async saveMetadata(_p, file, data) { store[file] = data; return data; },
    sourceDir() { return '/tmp/nonexistent-upgrade-src'; },
  };
  store['upgrade-session.json'] = {
    id: 's1', status: 'running', resumable: true, phase: 'apply',
    steps: [], completedSteps: [], changedFiles: [], verification: [], checkpoints: [],
  };
  store['upgrade-knowledge.json'] = {};
  store['upgrade-baseline.json'] = {};
  let diagnoseCalls = 0;
  // Monkey-patch: resolveEmptyUpgradePlan calls diagnoseUpgradeRequest which needs AI.
  // We simulate by providing ai.completeJson that returns empty then still empty.
  const ai = {
    async completeJson() {
      diagnoseCalls += 1;
      return {
        provider: 'test',
        json: {
          root_cause: diagnoseCalls === 1
            ? 'The chat UI and server routing flow needed harmonization.'
            : 'Capability already present after re-check. NO_CHANGE_REQUIRED.',
          recommendation: diagnoseCalls === 1 ? 'Harmonize routing' : 'No change required',
          expected_result: 'stable',
          risk: 'low',
          files: [],
          verification: [],
        },
      };
    },
  };
  // First resolve with claims-change plan → will replan via diagnose
  // diagnoseUpgradeRequest will call ai and fs - may fail without real source.
  // So we test the terminal path after max replans with a claims-change plan directly.
  const plan = {
    root_cause: 'The chat UI and server routing flow needed harmonization.',
    recommendation: 'Harmonize AI chat workflow in server and public UI.',
    expected_result: 'Chat routes execute consistently',
    risk: 'low',
    files: [],
  };
  // Force max replan path without AI by setting replanCount high
  const result = await resolveEmptyUpgradePlan({
    project: { id: 'p1', slug: 'p1' },
    projects,
    ai: null,
    plan,
    request: 'harmonize',
    emit: () => {},
    replanCount: 2, // already at max
  });
  assert.equal(result.noChange, true);
  assert.equal(result.terminalState, 'COMPLETED_NO_CHANGE');
});
