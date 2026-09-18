import path from 'node:path';
import { loadConfig, validateConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { openDb } from './storage/db.js';
import { AIGateway } from './ai/gateway.js';
import { ProjectManager } from './projects/manager.js';
import { SnapshotStore } from './projects/snapshots.js';
import { JobQueue } from './jobs/queue.js';
import { registerPipeline } from './jobs/pipeline.js';
import { GitHubManager } from './github/manager.js';
import { ReleaseManager } from './release/manager.js';
import { BuildRunner } from './docker/runner.js';
import { Sandbox } from './docker/sandbox.js';
import { registerRoutes } from './api/routes.js';
import { createApp, listen } from './http.js';
import { createPreviewHandler } from './preview.js';
import { gcDocker, reapIdlePreviews } from './docker/cleanup.js';

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);
const db = openDb(cfg.dataDir);
hydrateSecrets(cfg, db);
const check = validateConfig(cfg);
for (const w of check.warnings) log.warn(w);

const snapshots = new SnapshotStore({ cfg, db, log });
const projects = new ProjectManager({ cfg, db, log, snapshots });
const jobs = new JobQueue({ db, log });
const ai = new AIGateway({ cfg, db, log });
const github = new GitHubManager({ cfg, log });
const releases = new ReleaseManager({ cfg, db, log });
const runner = new BuildRunner({ cfg, log });
const sandbox = new Sandbox({ cfg, log, runner });

const ctx = { cfg, db, log, ai, projects, snapshots, jobs, github, releases, runner, sandbox };
registerPipeline(ctx);
const resumed = jobs.resumeInterrupted();
if (resumed) log.warn('Marked interrupted jobs as failed', { count: resumed });

gcDocker({ cfg, log }).catch((err) => log.warn('startup docker cleanup skipped', { error: String(err.message || err) }));
const idleMs = Number(process.env.PREVIEW_IDLE_MS || 15 * 60 * 1000);
setInterval(() => {
  reapIdlePreviews({ projects, runner, idleMs, log }).catch((err) => log.warn('idle preview cleanup skipped', { error: String(err.message || err) }));
}, 60 * 1000).unref();

const app = createApp();
registerRoutes(app, ctx);

const publicDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
const server = listen(app, {
  port: cfg.port,
  bind: cfg.bind,
  publicDir,
  log,
  preview: createPreviewHandler({ projects }),
});
log.info('Listening', {
  version: cfg.version,
  port: cfg.port,
  engine: 'docker',
  ai: cfg.ai.provider,
  open: `http://127.0.0.1:${cfg.port}/`,
});

function shutdown(signal) {
  log.info('Shutting down', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function hydrateSecrets(cfg, db) {
  const saved = db.setting('runtimeSecrets', null);
  if (!saved || typeof saved !== 'object') return;
  if (saved.AI_PROVIDER) { process.env.AI_PROVIDER = saved.AI_PROVIDER; cfg.ai.provider = saved.AI_PROVIDER; }
  if (saved.AI_MODE) { process.env.AI_MODE = saved.AI_MODE; cfg.ai.mode = saved.AI_MODE === 'council' ? 'council' : 'single'; }
  if (saved.GEMINI_API_KEY) { process.env.GEMINI_API_KEY = saved.GEMINI_API_KEY; cfg.ai.geminiKey = saved.GEMINI_API_KEY; }
  if (saved.GEMINI_MODEL) { process.env.GEMINI_MODEL = saved.GEMINI_MODEL; cfg.ai.geminiModel = saved.GEMINI_MODEL; }
  if (saved.DEEPSEEK_API_KEY) { process.env.DEEPSEEK_API_KEY = saved.DEEPSEEK_API_KEY; cfg.ai.deepseekKey = saved.DEEPSEEK_API_KEY; }
  if (saved.DEEPSEEK_MODEL) { process.env.DEEPSEEK_MODEL = saved.DEEPSEEK_MODEL; cfg.ai.deepseekModel = saved.DEEPSEEK_MODEL; }
  if (saved.GITHUB_TOKEN) { process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN; cfg.github.token = saved.GITHUB_TOKEN; }
  if (saved.GITHUB_OWNER) { process.env.GITHUB_OWNER = saved.GITHUB_OWNER; cfg.github.owner = saved.GITHUB_OWNER; }
}
