import { uuid } from '../utils/ids.js';

export class JobQueue {
  constructor({ db, log, history = null }) {
    this.db = db;
    this.log = log;
    this.history = history;
    this.handlers = new Map();
    this.active = new Set();
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  enqueue({ type, projectId = null, payload = {} }) {
    const id = uuid();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO jobs(id,project_id,type,status,stage,payload,result,error,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id, projectId, type, 'queued', 'queued', JSON.stringify(payload), null, null, now, now,
    );
    this.emit(id, 'queued', 'queued', 'Job started.');
    return this.get(id);
  }

  get(id) {
    const job = this.db.get('SELECT * FROM jobs WHERE id = ?', id);
    if (!job) return null;
    job.payload = safe(job.payload, {});
    job.result = safe(job.result, null);
    job.events = this.db.all(
      'SELECT stage,status,message,created_at FROM job_events WHERE job_id = ? ORDER BY id ASC',
      id,
    );
    return job;
  }

  list({ projectId, limit = 30 } = {}) {
    if (projectId) {
      return this.db.all(
        'SELECT id,project_id,type,status,stage,error,created_at,updated_at FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
        projectId, limit,
      );
    }
    return this.db.all(
      'SELECT id,project_id,type,status,stage,error,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT ?',
      limit,
    );
  }

  emit(jobId, stage, status, message) {
    this.db.run(
      'INSERT INTO job_events(job_id,stage,status,message,created_at) VALUES(?,?,?,?,?)',
      jobId, stage, status, message, new Date().toISOString(),
    );
    // Event status "done" means a step finished. The job stays running until
    // finish()/fail()/requestCancel(). Otherwise Publish disappears from chat
    // as soon as the first validate step emits "done".
    const current = this.db.get('SELECT status FROM jobs WHERE id = ?', jobId);
    const terminal = current && ['done', 'failed', 'cancelled'].includes(current.status);
    if (!terminal) {
      this.db.run(
        'UPDATE jobs SET stage=?, status=?, updated_at=? WHERE id=?',
        stage, 'running', new Date().toISOString(), jobId,
      );
    }
  }

  latestJob(projectId = null) {
    return projectId
      ? this.db.get('SELECT id,project_id,type,status,stage,error,created_at,updated_at FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', projectId)
      : this.db.get('SELECT id,project_id,type,status,stage,error,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT 1');
  }

  runningJob(projectId = null) {
    const rows = this.db.all(
      projectId
        ? "SELECT id,project_id,type,status,stage,error,created_at,updated_at FROM jobs WHERE project_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1"
        : "SELECT id,project_id,type,status,stage,error,created_at,updated_at FROM jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1"
      , ...(projectId ? [projectId] : [])
    );
    return rows[0] || null;
  }

  isBusy(projectId = null) {
    for (const id of this.active) {
      const job = this.db.get('SELECT project_id FROM jobs WHERE id = ?', id);
      if (!projectId || job?.project_id === projectId) return true;
    }
    const row = projectId
      ? this.db.get("SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued','running') LIMIT 1", projectId)
      : this.db.get("SELECT id FROM jobs WHERE status IN ('queued','running') LIMIT 1");
    return Boolean(row);
  }

  attachProject(jobId, projectId) {
    if (!jobId || !projectId) return;
    this.db.run('UPDATE jobs SET project_id=?, updated_at=? WHERE id=?', projectId, new Date().toISOString(), jobId);
  }

  finish(jobId, result) {
    this.db.run(
      'UPDATE jobs SET status=?, stage=?, result=?, updated_at=? WHERE id=?',
      'done', 'done', JSON.stringify(result || {}), new Date().toISOString(), jobId,
    );
    this.emit(jobId, 'done', 'done', 'Job finished.');
  }

  fail(jobId, error) {
    this.db.run(
      'UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?',
      'failed', String(error).slice(0, 2000), new Date().toISOString(), jobId,
    );
    this.emit(jobId, 'failed', 'failed', String(error).slice(0, 1800));
  }

  /**
   * Mark a job as cancelled from the user's perspective. The underlying async work
   * (a Docker build, a GitHub push) may already be running and cannot be killed
   * mid-flight safely, so this does not abort the OS process — it flags the job so
   * the UI can stop waiting on it and the user can start a new action immediately.
   */
  requestCancel(jobId) {
    const job = this.get(jobId);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'failed') return job;
    this.db.run('UPDATE jobs SET status=?, updated_at=? WHERE id=?', 'cancelled', new Date().toISOString(), jobId);
    this.emit(jobId, job.stage || 'running', 'failed', 'Cancelled by user.');
    return this.get(jobId);
  }

  resumeInterrupted() {
    const rows = this.db.all(`SELECT id FROM jobs WHERE status IN ('queued','running')`);
    for (const row of rows) {
      this.fail(row.id, 'Interrupted by application restart. Re-run the action.');
    }
    return rows.length;
  }

  async kick(job) {
    if (this.active.has(job.id)) return;
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.fail(job.id, `No handler for job type ${job.type}`);
      return;
    }
    this.active.add(job.id);
    this.emit(job.id, job.stage || 'running', 'running', 'Working…');
    try {
      const result = await handler(job, {
        emit: (stage, status, message) => this.emit(job.id, stage, status, message),
      });
      this.finish(job.id, result);
      if (this.history && job.payload?.projectId) Promise.resolve(this.history({ ...job, result }, 'done')).catch(() => {});
    } catch (err) {
      this.log.error('Job failed', { job: job.id, error: err.message });
      this.fail(job.id, err.message);
      if (this.history && job.payload?.projectId) Promise.resolve(this.history({ ...job, error: err.message }, 'failed')).catch(() => {});
    } finally {
      this.active.delete(job.id);
    }
  }
}

function safe(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
