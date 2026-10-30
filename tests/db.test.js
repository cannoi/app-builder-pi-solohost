import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/storage/db.js';
import { JobQueue } from '../src/jobs/queue.js';
import { createLogger } from '../src/utils/logger.js';

test('job queue persists and resumes interrupted work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pafdb-'));
  const db = openDb(dir);
  const jobs = new JobQueue({ db, log: createLogger('error') });
  const job = jobs.enqueue({ type: 'noop', payload: { a: 1 } });
  assert.equal(jobs.get(job.id).status, 'queued');
  const n = jobs.resumeInterrupted();
  assert.ok(n >= 1);
  assert.equal(jobs.get(job.id).status, 'failed');
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
