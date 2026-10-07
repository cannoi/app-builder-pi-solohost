/**
 * Mount Universal AI + Feedback onto Builder.
 * Unifies robot-panel AI with Builder coding AI hub when panel has no own key.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../..');

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
  throw new Error('Universal AI modules not found under src/lib or lib. Checked: ' + candidates.join(', '));
}

export function mountUniversalModules(app, { cfg, log, builderAI = null } = {}) {
  const libRoot = resolveLibRoot();
  const { createAIService } = require(path.join(libRoot, 'ai-module', 'ai-service.cjs'));
  const { mountAIRoutes } = require(path.join(libRoot, 'ai-module', 'routes.cjs'));
  const { createFeedbackService, mountFeedbackRoutes } = require(path.join(libRoot, 'feedback-module', 'feedback-service.cjs'));
  const adapter = require(path.join(libRoot, 'app-adapter.cjs'));

  const dataDir = path.join(root, 'data');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ok */ }

  async function cloudFallback({ message, history }) {
    if (!builderAI || typeof builderAI.complete !== 'function') return null;
    try {
      const st = typeof builderAI.status === 'function' ? builderAI.status() : {};
      if (!st?.configured) return null;
      const system = [
        adapter.knowledge || '',
        'You are the in-app assistant for App Builder — Pi SoloHost.',
        'Reply in the user\'s language (Vietnamese or English). Be short and practical.',
        'Help with: build app, preview/Run, Publish (needs GitHub token), Feedback panel, Settings.',
        'Never ask for wallet seeds or private keys. Never expose secrets.',
      ].join('\n');
      const hist = Array.isArray(history) ? history.slice(-6) : [];
      const prompt = hist.length
        ? `${hist.map((h) => `${h.role}: ${h.content}`).join('\n')}\nuser: ${message}`
        : String(message || '');
      const out = await builderAI.complete({
        task: 'USER_CHAT',
        prompt,
        system,
        json: false,
      });
      const reply = String(out?.text || out?.reply || out?.content || '').trim();
      if (!reply) return null;
      return { reply, provider: out?.provider || 'builder-hub', model: out?.model || 'auto' };
    } catch (err) {
      log?.warn?.('builder AI fallback for panel chat failed', { error: String(err?.message || err) });
      return null;
    }
  }

  const ai = createAIService({
    dataDir,
    appName: cfg?.title || cfg?.appName || SHFH_DEFAULTS.appName,
    adapter,
    cloudFallback,
    builderReady: () => {
      try {
        return Boolean(builderAI && typeof builderAI.status === 'function' && builderAI.status()?.configured);
      } catch { return false; }
    },
  });
  mountAIRoutes(app, ai);

  // Status enrichment: show configured when Builder coding AI is ready
  const origStatus = app; // routes already mounted; wrap GET /api/ai/status via extra route is hard — instead patch publicSettings
  // Re-register status is not easy; chat path uses cloudFallback which is enough.

  const fbOpts = {
    appId: cfg?.feedbackHub?.appId || process.env.FEEDBACK_APP_ID || SHFH_DEFAULTS.appId,
    appName: cfg?.feedbackHub?.appName || SHFH_DEFAULTS.appName,
    version: cfg?.version || '1.4.75',
    hubId: process.env.SHFH_HUB_ID || cfg?.feedbackHub?.hubId || SHFH_DEFAULTS.hubId,
    baseUrl: process.env.SHFH_HUB_URL || cfg?.feedbackHub?.url || SHFH_DEFAULTS.baseUrl,
    ingestToken: process.env.SHFH_INGEST_TOKEN || cfg?.feedbackHub?.ingestToken || SHFH_DEFAULTS.ingestToken,
  };

  const fb = createFeedbackService(fbOpts);
  mountFeedbackRoutes(app, fb);

  log?.info?.('Universal AI + Feedback mounted (unified with Builder AI)', {
    appId: fbOpts.appId,
    hubId: fbOpts.hubId,
    libRoot,
    builderAI: Boolean(builderAI),
  });

  return { ai, fb };
}
