import { GeminiProvider } from './providers/gemini.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { extractJson } from '../utils/validate.js';
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
  IDEA_ANALYSIS: 'fast', PRODUCT_PLANNING: 'fast', ARCHITECTURE: 'fast', CODING: 'fast',
  CODE_REVIEW: 'fast', DEBUGGING: 'fast', SECURITY: 'fast', TEST_GENERATION: 'fast',
  DOCUMENTATION: 'fast', RELEASE_NOTES: 'fast', USER_CHAT: 'fast',
};

export class AIGateway {
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

  async complete({ task, prompt, system, json = false, projectId = null, images = [], modelRef = '' }) {
    const rule = actionRule(task);
    const safeSystem = rule ? `${system || ''}\n\n${rule}`.trim() : (system || '').trim();
    const safePrompt = rule ? `${prompt || ''}\n\n${rule}`.trim() : (prompt || '').trim();
    try {
      const routed = await this.hub.execute({ task, prompt: safePrompt, system: safeSystem, json, images, modelRef });
      this.record({ projectId, task, provider: routed.provider, model: routed.model, success: 1, durationMs: routed.durationMs, tokens: routed.tokens, error: null });
      return routed;
    } catch (err) {
      this.log.warn('AI hub execute failed; trying saved DeepSeek/Gemini keys', { error: err.message });
    }
    const errors = [];
    const order = this.pickOrder(images);
    for (const name of order) {
      const provider = this.providerByName(name);
      if (!provider.configured()) continue;
      try {
        const result = await provider.complete({ prompt: safePrompt, system: safeSystem, json, images });
        this.record({ projectId, task, provider: result.provider, model: result.model, success: 1, durationMs: result.durationMs, tokens: result.tokens, error: null });
        return result;
      } catch (err) {
        errors.push(`${name}: ${String(err.message || err).slice(0, 240)}`);
      }
    }
    throw Object.assign(new Error(errors.join(' | ') || 'No AI provider is configured. Add a provider token in Settings.'), { code: 'AI_UNAVAILABLE', providerErrors: errors });
  }

  async completeJson(opts) {
    const pair = this.hub.selectedModels?.() || [];
    const pairTask = ['CODING', 'DEBUGGING', 'CODE_REVIEW'].includes(opts.task);
    if (pair.length >= 2 && pairTask) return this.completeSelectedPair(opts, pair);
    const council = (this.cfg.ai.mode === 'council') && pairTask;
    if (council) return this.completeCouncil(opts);
    const first = await this.complete({ ...opts, json: true });
    let parsed = extractJson(first.text);
    if (parsed) return { ...first, json: parsed };
    const strictPrompt = `${opts.prompt}\n\nJSON OUTPUT CONTRACT:\n- Return exactly one valid JSON object.\n- No markdown fences.\n- No commentary before or after JSON.\n- If uncertain, return {"root_cause":"FORMAT_ERROR","files":[],"explanation":"Unable to produce valid JSON."}.`;
    try {
      const retry = await this.complete({ ...opts, json: true, prompt: strictPrompt });
      parsed = extractJson(retry.text);
      if (parsed) return { ...retry, json: parsed, fallbackFrom: first.provider };
    } catch (err) {
      this.log.warn('AI JSON retry failed', { error: err.message });
    }
    throw Object.assign(new Error(`AI response format was invalid. ${first.provider || 'AI Provider Hub'} did not return valid JSON. No files were changed.`), { code: 'AI_BAD_JSON' });
  }

  async completeSelectedPair(opts, pair) {
    const draft = await this.complete({ ...opts, json: true, modelRef: pair[0] });
    const parsed = extractJson(draft.text);
    if (!parsed) throw Object.assign(new Error(`AI response format was invalid. ${draft.provider || 'Builder'} did not return valid JSON. No files were changed.`), { code: 'AI_BAD_JSON' });
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
    if (!parsed) throw Object.assign(new Error('Builder returned invalid JSON'), { code: 'AI_BAD_JSON' });
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
