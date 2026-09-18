import path from 'node:path';
import fs from 'node:fs/promises';
import { uuid, safeSlug } from '../utils/ids.js';
import { ensureDir, listFiles, dirSizeBytes, readJson, writeJson } from '../utils/fsx.js';

const STATES = [
  'IDEA', 'PLANNING', 'WAITING_INPUT', 'READY_TO_BUILD', 'BUILDING', 'TESTING', 'REPAIRING',
  'SECURITY_CHECK', 'SANDBOX', 'WAITING_APPROVAL', 'RELEASED', 'DEPLOYED',
  'FAILED', 'ROLLED_BACK',
];

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
    const rows = await readJson(path.join(this.projectRoot(project.slug), 'metadata', 'chat.json'), []);
    rows.push({ id: uuid(), role, message: String(message || ''), meta, createdAt: new Date().toISOString() });
    const trimmed = rows.slice(-300);
    await writeJson(path.join(this.projectRoot(project.slug), 'metadata', 'chat.json'), trimmed);
    return trimmed;
  }

  async chatHistory(project) {
    return readJson(path.join(this.projectRoot(project.slug), 'metadata', 'chat.json'), []);
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
