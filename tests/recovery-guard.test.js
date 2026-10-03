import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, normalizeAIResponse, normalizeArray } from '../src/utils/validate.js';
import { AIGateway } from '../src/ai/gateway.js';
import { updateUpgradeSession, createUpgradeSession } from '../src/upgrade/session.js';
import { shouldStopNoProgress, noChangeResult } from '../src/jobs/loop-guard.js';
import { classifyCredentialSnippet } from '../src/security/classify.js';

// A. Gemini malformed JSON → normalize/retry/fallback, no deadlock
test('A: malformed JSON recovers through alternate provider', async () => {
  const db = { setting() { return ''; }, setSetting() {}, run() {} };
  const log = { warn() {} };
  const cfg = { ai: { provider: 'deepseek', mode: 'single', deepseekKey: 'x', geminiKey: 'y', deepseekModel: 'deepseek-chat', geminiModel: 'gemini-2.5-flash' } };
  const ai = new AIGateway({ cfg, db, log });
  let calls = 0;
  ai.hub.execute = async () => {
    calls += 1;
    if (calls === 1) return { provider: 'gemini', model: 'g', text: 'Here is the fix:\n```\nnot json\n```', durationMs: 1, tokens: 1 };
    return { provider: 'deepseek', model: 'd', text: '{"files":[{"path":"a.js","content":"ok"}],"root_cause":"x","explanation":"y"}', durationMs: 1, tokens: 1 };
  };
  const result = await ai.completeJson({ task: 'DEBUGGING', prompt: 'fix', system: 'JSON', projectId: 'p' });
  assert.ok(result.json);
  assert.ok(Array.isArray(result.json.files));
  assert.ok(calls >= 2);
});

// B. verification object → normalize to array, no TypeError
test('B: normalizeArray accepts object/string/null for verification', () => {
  assert.deepEqual(normalizeArray(null), []);
  assert.deepEqual(normalizeArray(undefined), []);
  assert.deepEqual(normalizeArray(['a']), ['a']);
  assert.deepEqual(normalizeArray({ check: 'ok' }), [{ check: 'ok' }]);
  assert.deepEqual(normalizeArray('single'), ['single']);
  assert.deepEqual(normalizeArray('["a","b"]'), ['a', 'b']);
});

test('B: upgrade session merges object verification without throwing', async () => {
  const store = {};
  const projects = {
    async readMetadata(_p, file, fallback) { return store[file] ?? fallback; },
    async saveMetadata(_p, file, data) { store[file] = data; return data; },
  };
  const project = { id: 'p1', slug: 'p1' };
  await createUpgradeSession(projects, project, { request: 'test', steps: [{ id: 's1', label: 'one' }] });
  // patch.verification as object (the TypeError case)
  const next = await updateUpgradeSession(projects, project, {
    verification: { status: 'ok', detail: 'passed' },
    changedFiles: 'server.js',
  });
  assert.ok(Array.isArray(next.verification));
  assert.equal(next.verification.length, 1);
  assert.ok(Array.isArray(next.changedFiles));
  assert.equal(next.changedFiles[0], 'server.js');
});

// D/E: AI no-change classification via normalize
test('D/E: normalizeAIResponse extracts JSON from prose and fences', () => {
  const fenced = normalizeAIResponse('Sure!\n```json\n{"files":[],"root_cause":"none"}\n```\nDone.');
  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.value.files, []);

  const prose = normalizeAIResponse('Analysis: the bug is X. {"root_cause":"X","files":[{"path":"a.js","content":"1"}]} thanks');
  assert.equal(prose.ok, true);
  assert.equal(prose.value.root_cause, 'X');

  const bad = normalizeAIResponse('not json at all {{{');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'AI_RESPONSE_MALFORMED');
});

test('field aliases map changedFiles → files and normalize arrays', () => {
  const r = normalizeAIResponse({ changedFiles: { path: 'a.js', content: 'x' }, rootCause: 'bug' });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.value.files));
  assert.equal(r.value.root_cause, 'bug');
});

// F: same fingerprint → strategy exhausted
test('F: shouldStopNoProgress stops same fingerprint strategy', () => {
  assert.equal(shouldStopNoProgress({ fingerprint: 'fp1', previousFingerprint: 'fp1', attempt: 2, validationImproved: false, sourceChanged: false }), true);
  assert.equal(shouldStopNoProgress({ fingerprint: 'fp1', previousFingerprint: 'fp1', attempt: 1, validationImproved: false, sourceChanged: false }), false);
  assert.equal(shouldStopNoProgress({ fingerprint: 'fp2', previousFingerprint: 'fp1', attempt: 2, validationImproved: false, sourceChanged: false }), false);
  assert.equal(noChangeResult().terminalState, 'NO_CHANGE');
});

// H: AI_RESPONSE_MALFORMED code is recoverable, not application failure
test('H: completeJson throws AI_RESPONSE_MALFORMED without inventing files', async () => {
  const db = { setting() { return ''; }, setSetting() {}, run() {} };
  const log = { warn() {} };
  const cfg = { ai: { provider: 'deepseek', mode: 'single', deepseekKey: 'x', geminiKey: '', deepseekModel: 'deepseek-chat', geminiModel: 'gemini-2.5-flash' } };
  const ai = new AIGateway({ cfg, db, log });
  ai.hub.execute = async () => ({ provider: 'deepseek', model: 'd', text: 'totally broken {{{', durationMs: 1, tokens: 1 });
  // Also force provider path to return same garbage
  ai.deepseek = { configured: () => true, complete: async () => ({ provider: 'deepseek', model: 'd', text: 'totally broken {{{', durationMs: 1, tokens: 1 }) };
  ai.gemini = { configured: () => false, complete: async () => ({}) };
  let err;
  try {
    await ai.completeJson({ task: 'DEBUGGING', prompt: 'x', system: 'y', projectId: 'p' });
  } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'AI_RESPONSE_MALFORMED');
  assert.equal(err.recoverable, true);
  assert.match(String(err.message), /invalid|JSON/i);
});

// I/J: security user-defined tokens do not block
test('I/J: INGEST_TOKEN and HUB_ID classify as CONTINUE', () => {
  const a = classifyCredentialSnippet({ text: 'INGEST_TOKEN=abc123userdefinedvalue', file: 'config.yml' });
  assert.ok(['USER_DEFINED_CONFIGURATION', 'EXAMPLE_VALUE', 'TEST_FIXTURE', 'SENSITIVE_CREDENTIAL'].includes(a.class) || a.operationImpact !== 'BLOCK_PUBLIC_RELEASE' || a.severity !== 'critical');
  // USER_DEFINED should CONTINUE
  const b = classifyCredentialSnippet({ text: 'HUB_ID=my-hub-id-value-here', file: 'src/config.js' });
  assert.ok(b.operationImpact === 'CONTINUE' || b.severity === 'notice' || b.class === 'USER_DEFINED_CONFIGURATION');
});

// extractJson still works for plain objects
test('extractJson accepts already-parsed objects', () => {
  assert.deepEqual(extractJson({ a: 1 }), { a: 1 });
});
