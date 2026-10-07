/**
 * Mount Universal AI + Feedback (CJS modules) onto Builder ESM HTTP app.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../..');

export function mountUniversalModules(app, { cfg, log } = {}) {
  const { createAIService } = require(path.join(root, 'lib/ai-module/ai-service.cjs'));
  const { mountAIRoutes } = require(path.join(root, 'lib/ai-module/routes.cjs'));
  const { createFeedbackService, mountFeedbackRoutes } = require(path.join(root, 'lib/feedback-module/feedback-service.cjs'));
  const adapter = require(path.join(root, 'lib/app-adapter.cjs'));

  const dataDir = path.join(root, 'data');
  const ai = createAIService({
    dataDir,
    appName: cfg?.title || cfg?.appName || 'App Builder — Pi SoloHost',
    adapter,
  });
  mountAIRoutes(app, ai);

  const fbOpts = {
    appId: cfg?.feedbackHub?.appId || process.env.FEEDBACK_APP_ID || 'app-builder-pi-solohost',
    appName: cfg?.feedbackHub?.appName || 'App Builder — Pi SoloHost',
    version: cfg?.version || '1.4.71',
  };
  if (process.env.SHFH_HUB_ID) fbOpts.hubId = process.env.SHFH_HUB_ID;
  else if (cfg?.feedbackHub?.hubId) fbOpts.hubId = cfg.feedbackHub.hubId;
  if (process.env.SHFH_HUB_URL) fbOpts.baseUrl = process.env.SHFH_HUB_URL;
  else if (cfg?.feedbackHub?.url) fbOpts.baseUrl = cfg.feedbackHub.url;
  if (process.env.SHFH_INGEST_TOKEN) fbOpts.ingestToken = process.env.SHFH_INGEST_TOKEN;
  else if (cfg?.feedbackHub?.ingestToken) fbOpts.ingestToken = cfg.feedbackHub.ingestToken;

  const fb = createFeedbackService(fbOpts);
  mountFeedbackRoutes(app, fb);

  log?.info?.('Universal AI + Feedback modules mounted', {
    appId: fbOpts.appId,
    aiDataDir: dataDir,
  });

  return { ai, fb };
}
