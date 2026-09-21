import path from 'node:path';
import fs from 'node:fs/promises';
import { uuid, safeSlug } from '../utils/ids.js';
import { ensureDir, listFiles, dirSizeBytes, readJson, writeJson } from '../utils/fsx.js';

const STATES = [
  'IDEA', 'PLANNING', 'WAITING_INPUT', 'READY_TO_BUILD', 'BUILDING', 'TESTING', 'REPAIRING',
  'SECURITY_CHECK', 'SANDBOX', 'WAITING_APPROVAL', 'RELEASED', 'DEPLOYED',
  'FAILED', 'ROLLED_BACK',
];
const RETENTION_DAYS = 30;

export class ProjectManager {
  constructor({ cfg, db, log, snapshots }) {
    this.cfg = cfg;
    this.db = db;
    this.log = log;
    this.snapshots = snapshots;
  }

  projectRoot(slug) {
    return path.join(this.cfg.projectsDir, slug);
  }

  sourceDir(slug) {
    return path.join(this.projectRoot(slug), 'source');
  }

  async create({ idea, name, analysis = {}, plan = {} }) {
    const display = name || analysis.name || 'New App';
    let slug = safeSlug(analysis.slug || display);
    if (this.db.get('SELECT id FROM projects WHERE slug = ?', slug)) {
      slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    }
    const id = uuid();
    const now = new Date().toISOString();
    const manifest = {
      id, name: display, slug, version: '0.1.0', created_at: now,
      stack: analysis.recommended_stack || {},
      status: 'PLANNING',
      ai_provider: this.cfg.ai.provider,
      container_engine: 'podman-api',
    };
    this.db.run(
      `INSERT INTO projects(id,slug,name,idea,status,version,stack,manifest,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id, slug, display, idea, 'PLANNING', '0.1.0',
      JSON.stringify(analysis.recommended_stack || {}),
      JSON.stringify(manifest), now, now,
    );
    const root = this.projectRoot(slug);
    for (const part of ['source', 'tests', 'artifacts', 'logs', 'snapshots', 'metadata']) {
      await ensureDir(path.join(root, part));
    }
    await writeJson(path.join(root, 'metadata', 'project.json'), manifest);
    await writeJson(path.join(root, 'metadata', 'requirements.json'), analysis);
    await writeJson(path.join(root, 'metadata', 'architecture.json'), plan);
    await writeJson(path.join(root, 'metadata', 'decisions.json'), plan.decisions || []);
    return this.get(id);
  }

  list() {
    return this.db.all('SELECT * FROM projects ORDER BY updated_at DESC').map(hydrate);
  }

  get(id) {
    const row = this.db.get('SELECT * FROM projects WHERE id = ?', id)
      || this.db.get('SELECT * FROM projects WHERE slug = ?', id);
    return row ? hydrate(row) : null;
  }

  setStatus(project, status) {
    if (!STATES.includes(status)) this.log.warn('Unknown status', { status });
    const now = new Date().toISOString();
    const manifest = { ...(project.manifest || {}), status, updated_at: now };
    this.db.run(
      'UPDATE projects SET status=?, manifest=?, updated_at=? WHERE id=?',
      status, JSON.stringify(manifest), now, project.id,
    );
    return this.get(project.id);
  }

  async saveMetadata(project, file, data) {
    const dest = path.join(this.projectRoot(project.slug), 'metadata', file);
    await writeJson(dest, data);
    return dest;
  }

  async readMetadata(project, file, fallback = null) {
    return readJson(path.join(this.projectRoot(project.slug), 'metadata', file), fallback);
  }

  projectDir(project) { return this.projectRoot(project.slug); }

  async chat(project, message, role = 'user', meta = {}) {
    const rows = pruneRows(await readJson(path.join(this.projectRoot(project.slug), 'metadata', 'chat.json'), []));
    rows.push({ id: uuid(), role, message: String(message || ''), meta, createdAt: new Date().toISOString() });
    const trimmed = rows.slice(-300);
    await writeJson(path.join(this.projectRoot(project.slug), 'metadata', 'chat.json'), trimmed);
    return trimmed;
  }

  async chatHistory(project) {
    const file = path.join(this.projectRoot(project.slug), 'metadata', 'chat.json');
    const rows = pruneRows(await readJson(file, []));
    await writeJson(file, rows.slice(-300));
    return rows.slice(-300);
  }

  async startWorkPlan(project, { jobId = null, message = '', action = 'builder_chat', steps = [], language = 'en' } = {}) {
    const now = new Date().toISOString();
    const plan = {
      id: uuid(),
      jobId,
      action,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      language,
      request: String(message || '').slice(0, 4000),
      steps: (steps || []).map((step, index) => ({
        id: `step-${index + 1}`,
        order: index + 1,
        action: String(step.action || 'reply'),
        goal: String(step.goal || '').slice(0, 1200),
        tests: Array.isArray(step.tests) ? step.tests.slice(0, 6) : [],
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        files: [],
        result: null,
        error: null,
        notes: [],
      })),
      reports: [],
      handoff: 'Plan created. Execute steps in order; preserve completed work and stop dependent steps after a failure.',
    };
    await this.saveMetadata(project, 'work-plan.json', plan);
    return plan;
  }

  async updateWorkPlan(project, patch = {}) {
    const current = await this.readMetadata(project, 'work-plan.json', null);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (patch.stepId) {
      next.steps = (current.steps || []).map((step) => step.id === patch.stepId
        ? {
            ...step,
            ...(patch.step || {}),
            updatedAt: next.updatedAt,
            ...(patch.step?.status === 'running' && !step.startedAt ? { startedAt: next.updatedAt } : {}),
            ...(patch.step?.status && ['done', 'failed', 'blocked'].includes(patch.step.status) ? { finishedAt: next.updatedAt } : {}),
          }
        : step);
      delete next.stepId;
      delete next.step;
    }
    await this.saveMetadata(project, 'work-plan.json', next);
    return next;
  }

  async finishWorkPlan(project, status = 'done', handoff = '') {
    return this.updateWorkPlan(project, {
      status,
      handoff: String(handoff || '').slice(0, 2400),
      finishedAt: new Date().toISOString(),
    });
  }

  async pruneRetention() {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const project of this.list()) {
      const root = this.projectRoot(project.slug);
      for (const file of ['chat.json', 'activity.json']) {
        const full = path.join(root, 'metadata', file);
        const rows = await readJson(full, null);
        if (Array.isArray(rows)) {
          const kept = rows.filter((row) => {
            const stamp = Date.parse(row?.createdAt || row?.t || row?.updatedAt || '');
            return !Number.isFinite(stamp) || stamp >= cutoff;
          }).slice(-300);
          await writeJson(full, kept);
        }
      }
      const snapshotRoot = path.join(root, 'snapshots');
      const snapshotEntries = await fs.readdir(snapshotRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of snapshotEntries) {
        const full = path.join(snapshotRoot, entry.name);
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async sourceFiles(project) {
    return listFiles(this.sourceDir(project.slug));
  }

  async sizeOk(project) {
    const bytes = await dirSizeBytes(this.projectRoot(project.slug));
    return bytes <= this.cfg.limits.maxProjectSizeMb * 1024 * 1024;
  }

  async archive(project) {
    const p = this.setStatus(project, 'ROLLED_BACK');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.cfg.workspaceDir, `archived-${project.slug}-${stamp}`);
    await fs.rename(this.projectRoot(project.slug), dest).catch(async () => {
      await ensureDir(dest);
    });
    return { ...p, archivedTo: dest };
  }
}

function hydrate(row) {
  return {
    ...row,
    stack: safeParse(row.stack, {}),
    manifest: safeParse(row.manifest, {}),
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function pruneRows(rows) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const stamp = Date.parse(row?.createdAt || row?.t || row?.updatedAt || '');
    return !Number.isFinite(stamp) || stamp >= cutoff;
  });
}
