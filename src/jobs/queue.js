import { uuid } from '../utils/ids.js';
import { BUDGET_MS, createDeadline } from '../core/budget.js';

export class JobQueue {
  constructor({ db, log, history = null }) {
    this.db = db;
    this.log = log;
    this.history = history;
    this.handlers = new Map();
    this.active = new Set();
    /** @type {Map<string, AbortController>} */
    this.controllers = new Map();
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
      'SELECT id,stage,status,message,created_at FROM job_events WHERE job_id = ? ORDER BY id ASC',
      id,
    );
    job.cancelRequested = this.controllers.get(id)?.signal?.aborted || job.status === 'cancelled';
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
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO job_events(job_id,stage,status,message,created_at) VALUES(?,?,?,?,?)',
      jobId, stage, status, message, now,
    );
    const current = this.db.get('SELECT status FROM jobs WHERE id = ?', jobId);
    const terminal = current && ['done', 'failed', 'cancelled', 'paused'].includes(current.status);
    if (!terminal) {
      const nextStatus = status === 'queued' ? 'queued' : 'running';
      // progress bump: stage change is real progress
      this.db.run(
        'UPDATE jobs SET stage=?, status=?, updated_at=? WHERE id=?',
        stage, nextStatus, now, jobId,
      );
      try {
        this.db.run('UPDATE jobs SET last_progress_at=? WHERE id=?', now, jobId);
      } catch {
        // column may not exist on old DBs — ignore
      }
    }
  }

  latestJob(projectId = null) {
    return projectId
      ? this.db.get('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', projectId)
      : this.db.get('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1');
  }

  runningJob(projectId = null) {
    for (const id of this.active) {
      const row = this.get(id);
      if (!row) continue;
      if (['cancelled', 'done', 'failed', 'paused'].includes(row.status)) continue;
      if (!projectId || row.project_id === projectId) return row;
    }
    return null;
  }

  isBusy(projectId = null) {
    for (const id of this.active) {
      const row = this.db.get('SELECT id,project_id,status FROM jobs WHERE id = ?', id);
      if (!row) continue;
      if (['cancelled', 'done', 'failed', 'paused'].includes(row.status)) continue;
      if (!projectId || row.project_id === projectId) return true;
    }
    return false;
  }

  /**
   * Real cancel: abort controller + terminal cancelled (never overwritten by finish/fail).
   */
  requestCancel(jobId) {
    const ctrl = this.controllers.get(jobId);
    if (ctrl) {
      try {
        ctrl.abort(Object.assign(new Error('Job cancelled by user'), { code: 'CANCELLED' }));
      } catch { /* */ }
    }
    this.db.run('UPDATE jobs SET status=?, updated_at=? WHERE id=?', 'cancelled', new Date().toISOString(), jobId);
    this.emit(jobId, 'cancelled', 'cancelled', 'Cancelled by user.');
    this.active.delete(jobId);
    this.controllers.delete(jobId);
    return this.get(jobId);
  }

  resumeInterrupted() {
    const rows = this.db.all(`SELECT id,type FROM jobs WHERE status IN ('running','queued')`);
    for (const row of rows) {
      if (String(row.type || '').startsWith('upgrade')) {
        this.db.run(
          'UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?',
          'paused',
          'Upgrade interrupted by application restart. The saved Upgrade session can be resumed.',
          new Date().toISOString(),
          row.id,
        );
        this.emit(row.id, 'paused', 'done', 'Upgrade paused safely after restart. Continue Upgrade to resume from the saved session.');
      } else {
        this.db.run(
          'UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?',
          'failed',
          'Interrupted by application restart.',
          new Date().toISOString(),
          row.id,
        );
      }
    }
  }

  async kick(job) {
    if (this.active.has(job.id)) return;
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.fail(job.id, `No handler for job type ${job.type}`);
      return;
    }

    const isPublish = job.type === 'release' || job.type === 'github';
    const jobMs = isPublish ? BUDGET_MS.JOB_PUBLISH : BUDGET_MS.JOB;
    const deadline = createDeadline({ ms: jobMs, label: `job:${job.type}` });
    const controller = new AbortController();
    const onDeadline = () => {
      try {
        controller.abort(deadline.signal.reason || new Error('JOB_TIMEOUT'));
      } catch { /* */ }
    };
    if (deadline.signal.aborted) onDeadline();
    else deadline.signal.addEventListener('abort', onDeadline, { once: true });

    this.controllers.set(job.id, controller);
    this.active.add(job.id);
    this.db.run('UPDATE jobs SET status=?, stage=?, updated_at=? WHERE id=?', 'running', 'running', new Date().toISOString(), job.id);

    let lastProgress = Date.now();
    const origEmit = this.emit.bind(this);
    const emit = (stage, status, message) => {
      lastProgress = Date.now();
      origEmit(job.id, stage, status, message);
    };

    const watchdog = setInterval(() => {
      const row = this.db.get('SELECT status FROM jobs WHERE id = ?', job.id);
      if (!row || ['done', 'failed', 'cancelled', 'paused'].includes(row.status)) return;
      const idle = Date.now() - lastProgress;
      if (idle >= BUDGET_MS.WATCHDOG) {
        const secs = Math.round(idle / 1000);
        origEmit(job.id, 'watchdog', 'running', `Still waiting (${secs}s)… You can Cancel or Switch model.`);
        lastProgress = Date.now(); // avoid spam every tick; next after another WATCHDOG
      }
      if (deadline.signal.aborted || controller.signal.aborted) {
        clearInterval(watchdog);
      }
    }, Math.min(15_000, BUDGET_MS.WATCHDOG));
    watchdog.unref?.();

    try {
      job._signal = controller.signal;
      const result = await handler(job, {
        emit,
        signal: controller.signal,
        deadline,
        checkCancelled: () => {
          if (controller.signal.aborted) {
            const err = controller.signal.reason || new Error('cancelled');
            err.code = err.code || 'CANCELLED';
            throw err;
          }
        },
      });
      const status = this.db.get('SELECT status FROM jobs WHERE id = ?', job.id)?.status;
      if (status === 'cancelled') return; // do not overwrite
      this.finish(job.id, result);
    } catch (err) {
      const status = this.db.get('SELECT status FROM jobs WHERE id = ?', job.id)?.status;
      if (status === 'cancelled') return;
      const code = err?.code || '';
      if (code === 'CANCELLED' || controller.signal.aborted) {
        this.db.run('UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?', 'cancelled', String(err?.message || 'Cancelled'), new Date().toISOString(), job.id);
        return;
      }
      if (code === 'DEADLINE' || code === 'JOB_TIMEOUT') {
        this.fail(job.id, `JOB_TIMEOUT: ${err?.message || 'Job exceeded time budget'}`);
        return;
      }
      this.fail(job.id, err);
    } finally {
      clearInterval(watchdog);
      this.active.delete(job.id);
      this.controllers.delete(job.id);
      deadline.abort();
    }
  }

  finish(jobId, result) {
    const row = this.db.get('SELECT status FROM jobs WHERE id = ?', jobId);
    if (row && row.status === 'cancelled') return;
    this.db.run(
      'UPDATE jobs SET status=?, stage=?, result=?, error=?, updated_at=? WHERE id=?',
      'done', 'done', JSON.stringify(result ?? null), null, new Date().toISOString(), jobId,
    );
    this.emit(jobId, 'done', 'done', 'Job finished.');
    this.active.delete(jobId);
  }

  fail(jobId, error) {
    const row = this.db.get('SELECT status FROM jobs WHERE id = ?', jobId);
    if (row && row.status === 'cancelled') return;
    const message = typeof error === 'string' ? error : String(error?.message || error || 'failed');
    this.db.run(
      'UPDATE jobs SET status=?, stage=?, error=?, updated_at=? WHERE id=?',
      'failed', 'failed', message.slice(0, 2000), new Date().toISOString(), jobId,
    );
    this.emit(jobId, 'failed', 'failed', message.slice(0, 500));
    this.active.delete(jobId);
  }
}

function safe(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
