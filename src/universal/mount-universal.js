/**
 * Mount Universal AI + Feedback (CJS) onto Builder ESM HTTP app.
 * Resolves modules from src/lib (Docker COPY src) or lib/ (local/dev).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../..');

/** Built-in Feedback Hub defaults (server-side only — never sent to browser). */
const SHFH_DEFAULTS = {
  hubId: 'SHFH-CANNOI-0905428801',
  baseUrl: 'http://14.176.78.46:8090',
  ingestToken: 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9',
  appId: 'app-builder-pi-solohost',
  appName: 'App Builder — Pi SoloHost',
};

function resolveLibRoot() {
  const candidates = [
    path.join(root, 'src', 'lib'),
    path.join(root, 'lib'),
    path.join(__dirname, '..', 'lib'),
    '/app/src/lib',
    '/app/lib',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'ai-module', 'ai-service.cjs'))) return dir;
  }
  throw new Error(
    'Universal AI modules not found. Expected ai-service.cjs under src/lib/ai-module or lib/ai-module. ' +
    'Checked: ' + candidates.join(', '),
  );
}

export function mountUniversalModules(app, { cfg, log } = {}) {
  const libRoot = resolveLibRoot();
  const { createAIService } = require(path.join(libRoot, 'ai-module', 'ai-service.cjs'));
  const { mountAIRoutes } = require(path.join(libRoot, 'ai-module', 'routes.cjs'));
  const { createFeedbackService, mountFeedbackRoutes } = require(path.join(libRoot, 'feedback-module', 'feedback-service.cjs'));
  const adapter = require(path.join(libRoot, 'app-adapter.cjs'));

  const dataDir = path.join(root, 'data');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ok */ }

  const ai = createAIService({
    dataDir,
    appName: cfg?.title || cfg?.appName || SHFH_DEFAULTS.appName,
    adapter,
  });
  mountAIRoutes(app, ai);

  const fbOpts = {
    appId: cfg?.feedbackHub?.appId || process.env.FEEDBACK_APP_ID || SHFH_DEFAULTS.appId,
    appName: cfg?.feedbackHub?.appName || SHFH_DEFAULTS.appName,
    version: cfg?.version || '1.4.73',
    hubId: process.env.SHFH_HUB_ID || cfg?.feedbackHub?.hubId || SHFH_DEFAULTS.hubId,
    baseUrl: process.env.SHFH_HUB_URL || cfg?.feedbackHub?.url || SHFH_DEFAULTS.baseUrl,
    ingestToken: process.env.SHFH_INGEST_TOKEN || cfg?.feedbackHub?.ingestToken || SHFH_DEFAULTS.ingestToken,
  };

  const fb = createFeedbackService(fbOpts);
  mountFeedbackRoutes(app, fb);

  log?.info?.('Universal AI + Feedback modules mounted', {
    appId: fbOpts.appId,
    hubId: fbOpts.hubId,
    libRoot,
    aiDataDir: dataDir,
  });

  return { ai, fb };
}
