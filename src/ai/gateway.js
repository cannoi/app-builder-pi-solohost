import { call as clientCall, callJson as clientCallJson, deadlineMs, interpretJsonAnswer } from './client.js';
import { GeminiProvider } from './providers/gemini.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { extractJson, normalizeAIResponse, normalizeArray } from '../utils/validate.js';
import { uuid } from '../utils/ids.js';
import { pickRoles, recordTrust, reviewPrompt, scoreOf } from './council.js';
import { AIProviderHub } from './hub/hub.js';

export const SAFE_CHANGE_RULES = {
  CODING: `[ACTION: SAFE BUILD — MANDATORY]
Preserve the requested product behavior and existing project structure when present. Inspect first. Make the smallest necessary implementation. Do not remove working features or rewrite unrelated code. Protect secrets, credentials, wallet data, host/Docker access and system files. Validate build → start → health → functional test before claiming success.`,
  DEBUGGING: `[ACTION: SAFE REPAIR — MANDATORY]
Inspect evidence and identify the root cause before editing. Change only affected files and only what is required. Preserve working features, behavior, architecture, UI flow, configuration and data. Never weaken security, disable tests, hide errors, expose secrets, or change host/Docker/system access. If evidence is insufficient or the fix is risky, stop and explain. Validate and roll back if verification becomes worse.`,
  SECURITY: `[ACTION: SAFE SECURITY CHANGE — MANDATORY]
Inspect and verify the finding first. Fix only the confirmed security issue with the smallest targeted change. Preserve unrelated behavior. Never expose secrets or weaken security controls. Re-scan and test after the change. If the finding or safe fix is uncertain, do not edit.`,
  CODE_REVIEW: `[ACTION: INSPECT ONLY — MANDATORY]
Review evidence and report findings only. Do not modify files, remove features, or propose success as if changes were applied.`,
};

function actionRule(task) {
  return SAFE_CHANGE_RULES[task] || '';
}

const TASK_PREFERENCE = {
  // 1.8.13: product work prefers stronger models when the hub uses task complexity
  IDEA_ANALYSIS: 'strong', PRODUCT_PLANNING: 'strong', ARCHITECTURE: 'strong', CODING: 'strong',
  CODE_REVIEW: 'fast', DEBUGGING: 'strong', SECURITY: 'fast', TEST_GENERATION: 'fast',
  DOCUMENTATION: 'fast', RELEASE_NOTES: 'fast', USER_CHAT: 'fast',
};
export { TASK_PREFERENCE };


export class AIGateway {
  /** Preferred single entry (1.8.1+) */
  call(opts) { return clientCall(this, opts); }
  callJson(opts) { return clientCallJson(this, opts); }

  constructor({ cfg, db, log }) {
    this.cfg = cfg; this.db = db; this.log = log; this.refresh();
  }

  refresh() {
    this.gemini = new GeminiProvider({ apiKey: this.cfg.ai.geminiKey, model: this.cfg.ai.geminiModel, db: this.db, log: this.log });
    this.deepseek = new DeepSeekProvider({ apiKey: this.cfg.ai.deepseekKey, model: this.cfg.ai.deepseekModel });
    this.hub = new AIProviderHub({ cfg: this.cfg, db: this.db, log: this.log });
  }

  status() {
    const roles = pickRoles(this.cfg, this.db);
    const hub = this.hub?.publicState?.() || { connections: [] };
    return {
      primary: this.cfg.ai.provider,
      mode: this.cfg.ai.mode || 'single',
      routing: hub.mode || 'AUTO',
      gemini: this.gemini.configured(),
      deepseek: this.deepseek.configured(),
      configured: this.gemini.configured() || this.deepseek.configured() || (hub.connections || []).some((c) => c.status !== 'INVALID'),
      geminiModel: this.gemini.getStickyModel() || this.cfg.ai.geminiModel || null,
      hub,
      trust: {
        deepseek: scoreOf(roles.trust.deepseek),
        gemini: scoreOf(roles.trust.gemini),
      },
      builder: roles.builder,
      reviewer: roles.reviewer,
    };
  }

  async discoverGemini(force = false) {
    const result = await this.gemini.discover({ force });
    this.cfg.ai.geminiModel = result.model;
    return result;
  }

  pickOrder(images = []) {
    if (images?.length && this.gemini.configured()) return ['gemini', 'deepseek'];
    return this.cfg.ai.provider === 'gemini' ? ['gemini', 'deepseek'] : ['deepseek', 'gemini'];
  }

  providerByName(name) { return name === 'deepseek' ? this.deepseek : this.gemini; }

  async complete({ task, prompt, system, json = false, projectId = null, images = [], modelRef = '', signal = null, timeoutMs = 0, cancelSignal = null }) {
    const rule = actionRule(task);
    const safeSystem = rule ? `${system || ''}\n\n${rule}`.trim() : (system || '').trim();
    const safePrompt = (prompt || '').trim();
    // Single plane: Provider Hub first. 1.8.9 safety net: when the hub failed in AUTO mode (no user-selected model,
    // no explicit modelRef) and a DIFFERENT configured provider was never tried, use it once instead of blocking
    // the Builder (e.g. DeepSeek "Insufficient Balance" while a Gemini key is configured).
    let routed;
    try {
      routed = await this.hub.execute({ task, prompt: safePrompt, system: safeSystem, json, images, modelRef, signal, timeoutMs, cancelSignal });
    } catch (err) {
      routed = await this.legacySafetyNet(err, { prompt: safePrompt, system: safeSystem, json, images, modelRef, signal, timeoutMs, cancelSignal });
      if (!routed) throw err;
    }
    this.record({ projectId, task, provider: routed.provider, model: routed.model, success: 1, durationMs: routed.durationMs, tokens: routed.tokens, error: null });
    return routed;
  }

  /** One extra attempt on a configured legacy provider that the hub did not try (AUTO mode only). */
  async legacySafetyNet(err, { prompt, system, json, images, modelRef, signal, timeoutMs, cancelSignal }) {
    try {
      if (modelRef || err?.code === 'AI_CANCELLED' || signal?.aborted || cancelSignal?.aborted) return null;
      if ((this.hub?.selectedModels?.() || []).length) return null; // the user chose a model: respect the lock
      const tried = String((err?.providerErrors || []).join(' ') + ' ' + String(err?.message || '')).toLowerCase();
      const preferred = String(this.cfg?.ai?.provider || '').toLowerCase();
      const candidates = [['gemini', this.gemini], ['deepseek', this.deepseek]]
        .sort((a, b) => (a[0] === preferred ? 1 : 0) - (b[0] === preferred ? 1 : 0));
      for (const [name, provider] of candidates) {
        if (!provider?.apiKey || tried.includes(name)) continue;
        return await provider.complete({ prompt, system, json, images, signal, timeoutMs });
      }
    } catch { /* fall through to the original hub error */ }
    return null;
  }

  /**
   * JSON entry point. 1.8.9: the unified client (client.js) now owns parsing (Response Doctor), caller-schema
   * validation and the single targeted correction retry. When the user explicitly selected TWO models for a
   * code task, the builder + reviewer pair path (documented feature) is used again.
   */
  async completeJson(opts) {
    const selected = this.hub?.selectedModels?.() || [];
    if (selected.length >= 2 && ['CODING', 'DEBUGGING', 'CODE_REVIEW'].includes(opts?.task)) {
      return this.completeSelectedPair(opts, selected.slice(0, 2));
    }
    return clientCallJson(this, { ...opts, output: 'json' });
  }

  async completeSelectedPair(opts, pair) {
    const pairTimeout = deadlineMs('json', opts.task);
    const draft = await this.complete({ ...opts, json: true, modelRef: pair[0], timeoutMs: pairTimeout });
    let norm = interpretJsonAnswer(draft, null);
    let parsed = norm.ok ? norm.value : null;
    if (!parsed || (opts.validateJson && !opts.validateJson(parsed))) {
      // One strict retry on the builder model before failing the pair path
      try {
        const strictPrompt = `${opts.prompt}\n\nJSON OUTPUT CONTRACT: return exactly one valid JSON object. No markdown.`;
        const retry = await this.complete({ ...opts, json: true, modelRef: pair[0], prompt: strictPrompt, timeoutMs: pairTimeout });
        norm = interpretJsonAnswer(retry, null);
        parsed = norm.ok ? norm.value : null;
        if (parsed && (!opts.validateJson || opts.validateJson(parsed))) {
          Object.assign(draft, retry);
        }
      } catch { /* keep original failure path */ }
    }
    if (!parsed || (opts.validateJson && !opts.validateJson(parsed))) {
      throw Object.assign(
        new Error(`AI response format was invalid. ${draft.provider || 'Builder'} did not return the required JSON contract. No files were changed.`),
        { code: 'AI_RESPONSE_MALFORMED', provider: draft.provider || null, recoverable: true }
      );
    }
    const reviewPromptText = reviewPrompt(opts.task, parsed);
    try {
      const review = await this.complete({ task: 'CODE_REVIEW', prompt: reviewPromptText, json: true, modelRef: pair[1], projectId: opts.projectId });
      const reviewJson = extractJson(review.text);
      if (!reviewJson) throw new Error('Reviewer returned invalid JSON.');
      return { ...draft, json: parsed, council: { builder: draft.provider, reviewer: review.provider, review: reviewJson } };
    } catch (err) {
      this.log.warn('Selected reviewer failed; preserving verified builder result', { error: err.message });
      return { ...draft, json: parsed, council: { builder: draft.provider, reviewer: null, review: { accept: true, score: 80, issues: ['Reviewer unavailable'], reason: 'Builder result preserved because the selected reviewer could not complete.' }, reviewerError: String(err.message || err).slice(0, 180) } };
    }
  }

  async completeCouncil(opts) {
    const original = this.hub.state();
    const providers = (original.connections || []).filter((c) => c.status === 'VERIFIED').map((c) => c.provider);
    const firstProvider = original.preferredProvider !== 'AUTO' ? original.preferredProvider : providers[0];
    if (!firstProvider) return this.complete({ ...opts, json: true }).then((r) => ({ ...r, json: extractJson(r.text) }));
    const draft = await this.complete({ ...opts, json: true, prompt: `${opts.prompt}\n\nCouncil draft: return JSON only.` });
    const parsed = extractJson(draft.text);
    if (!parsed || (opts.validateJson && !opts.validateJson(parsed))) throw Object.assign(new Error('Builder returned invalid JSON contract'), { code: 'AI_RESPONSE_MALFORMED', recoverable: true });
    return { ...draft, json: parsed, council: { builder: draft.provider, reviewer: null, review: { accept: true, score: 80, issues: [], reason: 'Provider Hub handled the request.' } } };
  }

  record({ projectId, task, provider, model, success, durationMs, tokens, error }) {
    try {
      this.db.run(`INSERT INTO ai_requests(id,project_id,task,provider,model,success,duration_ms,tokens,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, uuid(), projectId, task, provider, model, success ? 1 : 0, durationMs, tokens, error, new Date().toISOString());
    } catch (e) { this.log.warn('Failed to record AI request', { error: e.message }); }
  }
}

function transientAiError(err) {
  const message = String(err?.message || err || '');
  return /HTTP (408|409|425|429|500|502|503|504)\b|timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|UNAVAILABLE|overloaded|temporar/i.test(message);
}
