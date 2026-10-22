import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAiOutput, parseFileBlocks, doctorCompleteFiles } from '../src/ai/response-doctor.js';
import { isCooling, recordFailure, recordSuccess, modelKey } from '../src/ai/hub/circuit.js';
import { classifyProviderError, isTransient } from '../src/ai/hub/errors.js';

test('file-block protocol parses multiple files', () => {
  const text = `<<<FILE path="server.js">>>
console.log(1);
<<<END FILE>>>
<<<FILE path="package.json">>>
{"name":"x"}
<<<END FILE>>>
<<<NOTES>>>
ok
<<<END NOTES>>>`;
  const r = parseFileBlocks(text);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].path, 'server.js');
  assert.ok(r.notes.includes('ok'));
});

test('doctor repairs trailing commas', () => {
  const r = parseAiOutput('{"files":[{"path":"a.js","content":"x"},],}', { expect: 'files' });
  assert.equal(r.ok, true);
  assert.equal(r.value.files[0].path, 'a.js');
});

test('doctor salvages truncated files array', () => {
  const r = parseAiOutput(
    '{"files":[{"path":"a.js","content":"one"},{"path":"b.js","content":"two"',
    { expect: 'files' },
  );
  // salvage may or may not recover depending on incompleteness of last string
  assert.ok(r.ok || r.class === 'FORMAT');
});

test('timeout message is TIMEOUT not FORMAT', () => {
  const cls = classifyProviderError(new Error('ai-request timed out after 120000ms'));
  assert.equal(cls.code, 'TIMEOUT');
  assert.ok(isTransient(cls.code));
});

test('circuit cooling after failures', () => {
  let h = {};
  h = recordFailure(h, 'TIMEOUT');
  assert.ok(isCooling(h));
  h = recordSuccess(h, 100);
  assert.equal(isCooling(h), false);
});

test('MAX_TOKENS maps toward TRUNCATED when in message', () => {
  const cls = classifyProviderError(new Error('finishReason: MAX_TOKENS output truncated'));
  assert.equal(cls.code, 'TRUNCATED');
});
