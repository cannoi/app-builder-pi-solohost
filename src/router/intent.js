/**
 * Deterministic intent routing for single-chat UX.
 * Fast path only for short, high-confidence commands.
 */
import { detectUserLanguage } from '../ai/language.js';
import { inferAction, parseGithubRepoUrl, isQuestion, splitUserSteps } from '../scripts/ops.js';

export const INTENTS = new Set([
  'CREATE', 'MODIFY', 'REPAIR', 'UPGRADE_IMPORT', 'IMPORT', 'RUN', 'PUBLISH',
  'EXPORT', 'DIAGNOSE', 'ASK', 'SETTINGS', 'UNDO',
]);

const GH_RE = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/i;
const GHCR_RE = /ghcr\.io\/[\w.\/\-]+(?::[\w.\-]+)?/i;

/** Multi-step connectors → must go through builder_chat */
export function isMultiStep(message = '') {
  const steps = splitUserSteps(message);
  if (steps.length >= 2) return true;
  return /(?:\brồi\b|\bsau\s*đó\b|\bxong\b|\bthen\b|\band\s+then\b)/iu.test(String(message || ''));
}

export function preRoute({ message = '', files = [], hasProject = false } = {}) {
  const text = String(message || '').trim();
  const lang = detectUserLanguage(text);
  if (files.some((f) => /\.zip$/i.test(f.name || f))) {
    return { intent: 'IMPORT', confidence: 0.95, reply_language: lang, reason: 'zip_attachment', fastPath: true };
  }
  if (GH_RE.test(text) && !files.length) {
    return { intent: 'UPGRADE_IMPORT', confidence: 0.95, reply_language: lang, reason: 'github_url', fastPath: true };
  }
  if (!text && !files.length) return null;
  return null;
}

export function actionToIntent(action, { hasProject = false } = {}) {
  switch (action) {
    case 'improve': return hasProject ? 'MODIFY' : 'CREATE';
    case 'publish': return 'PUBLISH';
    case 'export': return 'EXPORT';
    case 'run': return 'RUN';
    case 'analyze': return 'DIAGNOSE';
    case 'build': return 'CREATE';
    case 'reply': return 'ASK';
    default: return hasProject ? 'ASK' : 'CREATE';
  }
}

/**
 * Whether this decision may skip AI and enqueue a dedicated job.
 * PUBLISH never fast-paths. Multi-step never fast-paths.
 */
export function isFastPath(decision, message = '') {
  if (!decision) return false;
  if (isMultiStep(message)) return false;
  if (decision.confidence < 0.7) return false;
  const allow = new Set(['RUN', 'EXPORT', 'UNDO', 'UPGRADE_IMPORT', 'IMPORT']);
  // EXPORT only as zip download style — GHCR install kit is also export but still ok
  if (decision.intent === 'PUBLISH') return false;
  if (decision.intent === 'MODIFY' || decision.intent === 'REPAIR') return false;
  return allow.has(decision.intent);
}

export function routeIntent({ message = '', files = [], hasProject = false, aiResult = null } = {}) {
  const text = String(message || '').trim();
  const lang = detectUserLanguage(text);
  const pre = preRoute({ message: text, files, hasProject });
  if (pre) return { ...pre, steps: [pre.intent], risk: 'low', source: 'pre' };

  // Undo
  if (/(?:hoàn\s*tác|(?<![\p{L}\p{N}])undo(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])rollback(?![\p{L}\p{N}]))/iu.test(text)) {
    return {
      intent: 'UNDO',
      steps: ['UNDO'],
      confidence: 0.9,
      risk: 'low',
      reply_language: lang,
      source: 'infer',
      fastPath: true,
    };
  }

  if (aiResult && INTENTS.has(aiResult.intent)) {
    return {
      intent: aiResult.intent,
      steps: Array.isArray(aiResult.steps) ? aiResult.steps.slice(0, 5) : [aiResult.intent],
      confidence: Number(aiResult.confidence ?? 0.7),
      risk: aiResult.risk || 'low',
      reply_language: aiResult.reply_language || lang,
      reply: aiResult.reply || '',
      question: aiResult.question || null,
      source: 'ai',
    };
  }

  const action = inferAction(text);
  const intent = actionToIntent(action, { hasProject });
  const multi = isMultiStep(text);
  const confidence = action ? (multi ? 0.55 : 0.75) : 0.4;
  return {
    intent,
    steps: multi ? splitUserSteps(text).slice(0, 5) : [intent],
    confidence,
    risk: 'low',
    reply_language: lang,
    reply: '',
    question: null,
    source: action ? 'infer' : 'default',
    multiStep: multi,
  };
}

export default { preRoute, routeIntent, actionToIntent, isFastPath, isMultiStep, INTENTS };
