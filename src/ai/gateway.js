import { GeminiProvider } from './providers/gemini.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { extractJson } from '../utils/validate.js';
import { uuid } from '../utils/ids.js';
import { pickRoles, recordTrust, reviewPrompt, scoreOf } from './council.js';

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
  }

  status() {
    const roles = pickRoles(this.cfg, this.db);
    return {
      primary: this.cfg.ai.provider,
      mode: this.cfg.ai.mode || 'single',
      gemini: this.gemini.configured(),
      deepseek: this.deepseek.configured(),
      configured: this.gemini.configured() || this.deepseek.configured(),
      geminiModel: this.gemini.getStickyModel() || this.cfg.ai.geminiModel || null,
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

  pickOrder() {
    return this.cfg.ai.provider === 'gemini' ? ['gemini', 'deepseek'] : ['deepseek', 'gemini'];
  }

  providerByName(name) { return name === 'deepseek' ? this.deepseek : this.gemini; }

  async complete({ task, prompt, system, json = false, projectId = null, images = [] }) {
    const errors = [];
    const order = this.pickOrder(task);
    for (const name of order) {
      const provider = this.providerByName(name);
      if (!provider.configured()) continue;
      const started = Date.now();
      try {
        const result = await provider.complete({ prompt, system, json, images });
        this.record({ projectId, task, provider: result.provider, model: result.model, success: 1, durationMs: result.durationMs, tokens: result.tokens, error: null });
        if (name !== order[0]) result.fallbackFrom = order[0];
        return result;
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
        this.record({ projectId, task, provider: name, model: provider.model, success: 0, durationMs: Date.now() - started, tokens: null, error: err.message });
        this.log.warn('AI provider failed', { provider: name, task, error: err.message });
      }
    }
    const billed = errors.some((e) => /402|Insufficient Balance/i.test(e));
    const hint = billed ? ' DeepSeek has no credit. Switch the header to Gemini or add a Gemini key.' : '';
    const err = new Error((errors.length ? errors.join(' | ') : 'No AI provider is configured') + hint);
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  async completeJson(opts) {
    const council = (this.cfg.ai.mode === 'council') && ['CODING', 'DEBUGGING', 'CODE_REVIEW'].includes(opts.task);
    if (council) return this.completeCouncil(opts);

    // JSON is a hard contract for Builder actions. A malformed response must not
    // stop the workflow when another configured provider can safely answer.
    // Try the normal provider once, then a different configured provider once
    // with a stricter prompt. This avoids repeating the same broken response twice.
    const first = await this.complete({ ...opts, json: true });
    let parsed = extractJson(first.text);
    if (parsed) return { ...first, json: parsed };

    const fallbackName = first.provider === 'gemini' ? 'deepseek' : 'gemini';
    const fallback = this.providerByName(fallbackName);
    if (fallback?.configured()) {
      const strictPrompt = `${opts.prompt}\n\nJSON OUTPUT CONTRACT:\n- Return exactly one valid JSON object.\n- No markdown fences.\n- No commentary before or after JSON.\n- Escape all quotes and newlines inside string values.\n- Preserve file content exactly as JSON strings.\n- If you cannot produce a valid JSON object, return {"root_cause":"FORMAT_ERROR","files":[],"explanation":"Unable to produce valid JSON."}.`;
      try {
        const retry = await fallback.complete({ ...opts, json: true, prompt: strictPrompt });
        this.record({ projectId: opts.projectId || null, task: opts.task, provider: retry.provider, model: retry.model, success: 1, durationMs: retry.durationMs, tokens: retry.tokens, error: null });
        parsed = extractJson(retry.text);
        if (parsed) return { ...retry, json: parsed, fallbackFrom: first.provider };
      } catch (err) {
        this.record({ projectId: opts.projectId || null, task: opts.task, provider: fallbackName, model: fallback.model, success: 0, durationMs: 0, tokens: null, error: err.message });
        this.log.warn('AI JSON fallback failed', { provider: fallbackName, task: opts.task, error: err.message });
      }
    }

    throw Object.assign(new Error(`AI response format was invalid. ${first.provider || 'Primary AI'} did not return valid JSON${fallback?.configured() ? ' and the fallback could not recover it' : ''}. No files were changed.`), { code: 'AI_BAD_JSON' });
  }

  async completeCouncil(opts) {
    const roles = pickRoles(this.cfg, this.db);
    const builder = this.providerByName(roles.builder);
    if (!builder?.configured()) return this.complete({ ...opts, json: true }).then((first) => {
      const parsed = extractJson(first.text);
      if (!parsed) throw Object.assign(new Error('AI returned invalid JSON'), { code: 'AI_BAD_JSON' });
      return { ...first, json: parsed };
    });
    const started = Date.now();
    let draft;
    try {
      draft = await builder.complete({ prompt: opts.prompt, system: opts.system, json: true, images: opts.images || [] });
    } catch (err) {
      recordTrust(this.db, roles.builder, { ok: false, ms: Date.now() - started });
      const other = roles.builder === 'deepseek' ? 'gemini' : 'deepseek';
      const fallback = this.providerByName(other);
      if (!fallback?.configured()) throw err;
      this.log.warn('Council builder failed; switching provider', { from: roles.builder, to: other, error: err.message });
      roles.builder = other;
      roles.reviewer = roles.reviewer === other ? (other === 'deepseek' ? 'gemini' : 'deepseek') : roles.reviewer;
      draft = await fallback.complete({ prompt: opts.prompt, system: opts.system, json: true, images: opts.images || [] });
    }
    const parsed = extractJson(draft.text);
    if (!parsed) throw Object.assign(new Error('Builder returned invalid JSON'), { code: 'AI_BAD_JSON' });
    recordTrust(this.db, roles.builder, { ok: true, ms: Date.now() - started });
    let review = { accept: true, score: 80, issues: [], reason: 'No second model configured.' };
    if (roles.reviewer && this.providerByName(roles.reviewer)?.configured()) {
      try {
        const rev = await this.providerByName(roles.reviewer).complete({
          prompt: reviewPrompt(opts.task, parsed),
          system: 'Return only JSON.',
          json: true,
        });
        review = extractJson(rev.text) || review;
        recordTrust(this.db, roles.reviewer, { ok: review.accept !== false, ms: rev.durationMs || 2000 });
      } catch (err) {
        this.log.warn('Council reviewer failed', { error: err.message });
      }
    }
    if (review.accept === false && Array.isArray(review.issues) && review.issues.length) {
      try {
        const fixed = await builder.complete({
          prompt: `${opts.prompt}\n\nReviewer rejected the draft:\n${review.issues.join('\n')}\nReturn a corrected JSON only.`,
          system: opts.system,
          json: true,
          images: opts.images || [],
        });
        const repaired = extractJson(fixed.text);
        if (repaired) {
          recordTrust(this.db, roles.builder, { ok: true, ms: fixed.durationMs || 2000 });
          return { ...fixed, json: repaired, council: { builder: roles.builder, reviewer: roles.reviewer, review } };
        }
      } catch (err) {
        recordTrust(this.db, roles.builder, { ok: false, ms: Date.now() - started });
        this.log.warn('Council repair failed', { error: err.message });
      }
    }
    return { ...draft, json: parsed, council: { builder: roles.builder, reviewer: roles.reviewer, review } };
  }

  record({ projectId, task, provider, model, success, durationMs, tokens, error }) {
    try {
      this.db.run(`INSERT INTO ai_requests(id,project_id,task,provider,model,success,duration_ms,tokens,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, uuid(), projectId, task, provider, model, success ? 1 : 0, durationMs, tokens, error, new Date().toISOString());
    } catch (e) { this.log.warn('Failed to record AI request', { error: e.message }); }
  }
}
