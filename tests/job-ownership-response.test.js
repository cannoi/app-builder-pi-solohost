import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');

test('busy action returns the existing job as an attachable 202 response', () => {
  assert.match(source, /res\.status\(202\)\.json\(\{\s*busy: true,\s*reused: true,\s*jobId: current\?\.id \|\| null,/s);
});

test('busy response explains that the existing job is being followed', () => {
  assert.match(source, /message: 'An action is already running\. I kept the current job and will follow its result/);
});

test('current-job recovery endpoint can reconcile a stale client job id', () => {
  assert.match(source, /r\.get\('\/api\/jobs\/current'/);
  assert.match(source, /projectId/);
  assert.match(source, /runningJob\(projectId\)/);
  assert.match(source, /recovered: Boolean\(current\)/);
});
