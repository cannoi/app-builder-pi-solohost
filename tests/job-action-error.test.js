import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('409 job ownership errors attach the UI to the existing job', () => {
  assert.match(source, /function handleJobActionError\(e\)/);
  assert.match(source, /if \(e\?\.jobId\)/);
  assert.match(source, /watch\(e\.jobId\)/);
});

test('quick action errors with an existing job do not release the busy lock', () => {
  const quickStart = source.slice(source.indexOf('async function quick('), source.indexOf('async function askSafeAction('));
  assert.match(quickStart, /catch \(e\) \{ handleJobActionError\(e\); \}/);
  assert.doesNotMatch(quickStart, /catch \(e\) \{ setBusy\(false\); add\('ai', e\.message\); \}/);
});

test('job watcher does not create overlapping polls for the same job', () => {
  assert.match(source, /pollInFlight/);
  assert.match(source, /if \(state\.pollInFlight && state\.pollInFlightJobId === jobId\) return;/);
  assert.match(source, /watchSeq/);
});
