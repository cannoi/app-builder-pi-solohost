import { GeminiProvider } from './providers/gemini.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { extractJson } from '../utils/validate.js';
import { uuid } from '../utils/ids.js';
import { pickRoles, recordTrust, reviewPrompt, scoreOf } from './council.js';

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

  pickOrder(images = []) {
    if (images?.length && this.gemini.configured()) return ['gemini', 'deepseek'];
    return this.cfg.ai.provider === 'gemini' ? ['gemini', 'deepseek'] : ['deepseek', 'gemini'];
  }

  providerByName(name) { return name === 'deepseek' ? this.deepseek : this.gemini; }

  async complete({ task, prompt, system, json = false, projectId = null, images = [] }) {
    const errors = [];
    const rule = actionRule(task);
    const safeSystem = rule ? `${system || ''}\n\n${rule}`.trim() : (system || '').trim();
    const safePrompt = rule ? `${prompt || ''}\n\n${rule}`.trim() : (prompt || '').trim();
    const order = this.pickOrder(images);
    for (const name of order) {
      const provider = this.providerByName(name);
      if (!provider.configured()) continue;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const started = Date.now();
        try {
          const result = await provider.complete({ prompt: safePrompt, system: safeSystem, json, images });
          this.record({ projectId, task, provider: result.provider, model: result.model, success: 1, durationMs: result.durationMs, tokens: result.tokens, error: null });
          if (name !== order[0]) result.fallbackFrom = order[0];
          return result;
        } catch (err) {
          const detail = `${name} attempt ${attempt}: ${String(err.message || err).slice(0, 500)}`;
          errors.push(detail);
          this.record({ projectId, task, provider: name, model: provider.model, success: 0, durationMs: Date.now() - started, tokens: null, error: err.message });
          this.log.warn('AI provider failed', { provider: name, task, attempt, error: err.message });
          if (attempt < 2 && transientAiError(err)) {
            await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
            continue;
          }
          break;
        }
      }
    }
    const billed = errors.some((e) => /402|Insufficient Balance/i.test(e));
    const hint = billed ? ' DeepSeek has no credit. Switch the header to Gemini or add a Gemini key.' : '';
    const err = new Error((errors.length ? errors.join(' | ') : 'No AI provider is configured') + hint);
    err.code = 'AI_UNAVAILABLE';
    err.providerErrors = errors;
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
      const strictPrompt = `${opts.prompt}\n\n${actionRule(opts.task)}\n\nJSON OUTPUT CONTRACT:\n- Return exactly one valid JSON object.\n- No markdown fences.\n- No commentary before or after JSON.\n- Escape all quotes and newlines inside string values.\n- Preserve file content exactly as JSON strings.\n- If you cannot produce a valid JSON object, return {"root_cause":"FORMAT_ERROR","files":[],"explanation":"Unable to produce valid JSON."}.`;
      try {
        const retry = await fallback.complete({ ...opts, json: true, prompt: strictPrompt, system: actionRule(opts.task) ? `${opts.system || ''}\n\n${actionRule(opts.task)}`.trim() : (opts.system || '').trim() });
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
      draft = await builder.complete({ prompt: `${opts.prompt}\n\n${actionRule(opts.task)}`, system: actionRule(opts.task) ? `${opts.system || ''}\n\n${actionRule(opts.task)}`.trim() : (opts.system || '').trim(), json: true, images: opts.images || [] });
    } catch (err) {
      recordTrust(this.db, roles.builder, { ok: false, ms: Date.now() - started });
      const other = roles.builder === 'deepseek' ? 'gemini' : 'deepseek';
      const fallback = this.providerByName(other);
      if (!fallback?.configured()) throw err;
      this.log.warn('Council builder failed; switching provider', { from: roles.builder, to: other, error: err.message });
      roles.builder = other;
      roles.reviewer = roles.reviewer === other ? (other === 'deepseek' ? 'gemini' : 'deepseek') : roles.reviewer;
      draft = await fallback.complete({ prompt: `${opts.prompt}\n\n${actionRule(opts.task)}`, system: actionRule(opts.task) ? `${opts.system || ''}\n\n${actionRule(opts.task)}`.trim() : (opts.system || '').trim(), json: true, images: opts.images || [] });
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
          prompt: `${opts.prompt}\n\nReviewer rejected the draft:\n${review.issues.join('\n')}\nReturn a corrected JSON only.\n\n${actionRule(opts.task)}`,
          system: actionRule(opts.task) ? `${opts.system || ''}\n\n${actionRule(opts.task)}`.trim() : (opts.system || '').trim(),
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

function transientAiError(err) {
  const message = String(err?.message || err || '');
  return /HTTP (408|409|425|429|500|502|503|504)\b|timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|UNAVAILABLE|overloaded|temporar/i.test(message);
}
