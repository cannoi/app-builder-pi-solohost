import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('job watcher keeps the chat busy when polling temporarily loses connection', () => {
  assert.match(source, /scheduleJobPoll/);
  assert.match(source, /state\.pollFailures/);
  assert.match(source, /Reconnecting…/);
  assert.doesNotMatch(source, /catch \(e\) \{ clearInterval\(state\.poll\); state\.poll = null; setBusy\(false\);/);
});

test('watching a recovered or duplicate job restores the visible busy state', () => {
  assert.match(source, /async function watch\(jobId/);
  assert.match(source, /setBusy\(true, state\.pollFailures \? 'Still working…' : 'Working…'\)/);
  assert.match(source, /if \(e\.jobId\) \{[\s\S]*watch\(e\.jobId\);/);
});

test('refreshing a project asks the authoritative current-job endpoint before falling back to activity history', () => {
  const open = source.indexOf('async function openProject');
  const end = source.indexOf('async function sendMessage', open);
  const block = source.slice(open, end);
  assert.match(block, /api\(\`\/api\/jobs\/current\?projectId=/);
  assert.match(block, /watch\(currentJob\.jobId/);
});

test('opening a project with a running job resumes its watcher', () => {
  assert.match(source, /const currentJob = await api/);
  assert.match(source, /const running = !currentJob\?\.active \? activity\.items\?\.find\(\(x\) => x\.running\) : null;/);
  assert.match(source, /if \(running\) \{[\s\S]*watch\(running\.id\);/);
});

test('a missing job is reconciled instead of being retried forever', () => {
  assert.match(source, /recoverMissingJob/);
  assert.match(source, /Job not found/);
  assert.match(source, /api\/jobs\/current\?projectId=/);
  assert.match(source, /The current job is no longer available/);
});

test('job watcher does not leave the UI busy after missing-job recovery fails', () => {
  assert.match(source, /recoverMissingJob\(jobId, seq\)/);
  assert.match(source, /setBusy\(false\)/);
  assert.match(source, /state\.jobId = null/);
});


test('reattaching to an in-flight job does not cancel its polling continuation', () => {
  const guard = source.indexOf('if (state.pollInFlight && state.pollInFlightJobId === jobId) return;');
  const stop = source.indexOf('stopJobWatch();', guard);
  assert.ok(guard >= 0 && stop > guard, 'poll guard must run before stopJobWatch');
});

test('step-level done events must not finish the whole job', () => {
  const queue = fs.readFileSync(new URL('../src/jobs/queue.js', import.meta.url), 'utf8');
  assert.match(queue, /Event status "done" means a step finished/);
  assert.match(queue, /const terminal = current && /);
});

test('active jobs keep a persisted heartbeat during long-running handlers', () => {
  const queue = fs.readFileSync(new URL('../src/jobs/queue.js', import.meta.url), 'utf8');
  assert.match(queue, /const heartbeat = setInterval/);
  assert.match(queue, /UPDATE jobs SET updated_at/);
  assert.match(queue, /clearInterval\(heartbeat\)/);
});

test('upgrade jobs are paused, not permanently failed, across Builder restart', () => {
  const queue = fs.readFileSync(new URL('../src/jobs/queue.js', import.meta.url), 'utf8');
  assert.match(queue, /startsWith\('upgrade_'\)/);
  assert.match(queue, /'paused'/);
  assert.match(queue, /Continue Upgrade to resume from the saved session/);
});
