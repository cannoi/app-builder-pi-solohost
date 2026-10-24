/**
 * App Builder 1.8.1 — single AI call policy.
 * Product code should use call(ai, opts). Max 2 attempts + optional 1 format repair.
 */
import { actionRule } from './prompts.js';

const BREAKER = new Map(); // key -> { fails, openUntil }
const BREAKER_FAILS = 3;
const BREAKER_MS = 60_000;

function breakerKey(provider, model) {
  return `${provider || 'any'}::${model || 'default'}`;
}

function breakerOpen(key) {
  const st = BREAKER.get(key);
  if (!st) return false;
  if (st.openUntil && Date.now() < st.openUntil) return true;
  if (st.openUntil && Date.now() >= st.openUntil) {
    BREAKER.set(key, { fails: 0, openUntil: 0 });
    return false;
  }
  return false;
}

function breakerFail(key) {
  const st = BREAKER.get(key) || { fails: 0, openUntil: 0 };
  st.fails += 1;
  if (st.fails >= BREAKER_FAILS) st.openUntil = Date.now() + BREAKER_MS;
  BREAKER.set(key, st);
}

function breakerOk(key) {
  BREAKER.set(key, { fails: 0, openUntil: 0 });
}

function deadlineMs(output, task) {
  const t = String(task || '').toUpperCase();
  if (output === 'files' || /CODE|GENERATE|BUILD|FILE/.test(t)) return 240_000;
  if (output === 'json') return 60_000;
  return 45_000;
}

function classifyError(err) {
  const msg = String(err?.message || err || '');
  if (/not configured|NO_KEY|no active|no api key/i.test(msg)) return 'AI_NO_KEY';
  if (/HTTP 401|HTTP 403|INVALID_CREDENTIAL|auth|permission/i.test(msg)) return 'AI_AUTH';
  if (/HTTP 429|rate limit/i.test(msg)) return 'AI_RATE_LIMIT';
  if (/abort|timeout|timed out|deadline/i.test(msg)) return 'AI_TIMEOUT';
  if (/HTTP 5\d\d|UNAVAILABLE|overloaded|ECONN|fetch failed|network/i.test(msg)) return 'AI_UNAVAILABLE';
  if (/invalid json|format|parse/i.test(msg)) return 'AI_FORMAT';
  return 'AI_UNAVAILABLE';
}

/**
 * @param {object} ai AIGateway instance
 */
export async function call(ai, {
  task = 'USER_CHAT',
  system = '',
  prompt = '',
  images = [],
  output = 'text',
  signal = null,
  projectId = null,
  modelRef = '',
} = {}) {
  if (!ai || typeof ai.complete !== 'function') {
    const e = new Error('AI is not configured. Open Settings and add a provider key.');
    e.code = 'AI_NO_KEY';
    throw e;
  }

  const rule = typeof actionRule === 'function' ? actionRule(task) : '';
  const safeSystem = rule ? `${system || ''}\n\n${rule}`.trim() : String(system || '').trim();
  const safePrompt = String(prompt || '');
  const json = output === 'json';
  const ms = deadlineMs(output, task);
  const timeout = AbortSignal.timeout(ms);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;

  const key = breakerKey(modelRef || 'hub', 'primary');
  if (breakerOpen(key)) {
    const e = new Error('AI provider temporarily paused after repeated failures. Try again in a minute.');
    e.code = 'AI_UNAVAILABLE';
    throw e;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await ai.complete({
        task,
        system: safeSystem,
        prompt: safePrompt,
        json,
        images,
        signal: combined,
        projectId,
        modelRef: attempt === 1 ? modelRef : '',
      });
      breakerOk(key);
      return {
        ...result,
        text: result?.text ?? '',
        attempts: attempt,
        output,
      };
    } catch (err) {
      lastErr = err;
      const code = classifyError(err);
      err.code = err.code || code;
      if (code === 'AI_AUTH' || code === 'AI_NO_KEY') {
        breakerFail(key);
        throw err;
      }
      // 400-style: do not retry same body
      if (/HTTP 400/.test(String(err.message || ''))) {
        breakerFail(key);
        throw err;
      }
      if (code === 'AI_RATE_LIMIT') {
        const wait = Math.min(5000, 1500 * attempt);
        await new Promise((r) => setTimeout(r, wait));
      }
      breakerFail(key);
      if (attempt >= 2) break;
    }
  }
  throw lastErr || Object.assign(new Error('AI unavailable'), { code: 'AI_UNAVAILABLE' });
}

/** Convenience for JSON-shaped calls */
export async function callJson(ai, opts) {
  const r = await call(ai, { ...opts, output: 'json' });
  let json = r.json;
  if (json == null && r.text) {
    try {
      const m = String(r.text).match(/\{[\s\S]*\}/);
      if (m) json = JSON.parse(m[0]);
    } catch { /* format repair once */ }
    if (json == null) {
      const retry = await call(ai, {
        ...opts,
        output: 'json',
        prompt: `${opts.prompt}\n\nReturn valid JSON only.`,
      });
      try {
        const m = String(retry.text).match(/\{[\s\S]*\}/);
        if (m) json = JSON.parse(m[0]);
      } catch {
        const e = new Error('AI returned invalid JSON');
        e.code = 'AI_FORMAT';
        throw e;
      }
      return { ...retry, json };
    }
  }
  return { ...r, json };
}

export default { call, callJson };
