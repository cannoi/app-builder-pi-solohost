/**
 * App Builder — single AI call policy (1.8.2), hardened in 1.8.9.
 * SAFE_CHANGE_RULES are applied inside gateway.complete — do not re-append here.
 *
 * 1.8.9 changes (all additive / safer):
 *  - every attempt gets its OWN timeout signal (a timed-out first attempt can no longer poison the second);
 *  - the task-aware timeout is passed down to providers (they used to hard-code 45 s / 60 s, which cut
 *    large code generations short even though this module allowed 240 s);
 *  - timeouts are never retried identically; auth / no-key / bad-request are never retried;
 *  - JSON answers go through the Response Doctor (repair + truncation salvage), the caller schema is
 *    validated, and ONE targeted correction retry is made (different prompt, not an identical retry);
 *  - a NEED_FILES request is returned to the caller instead of being thrown away as "invalid JSON";
 *  - error classification uses word boundaries (a stray "401" inside a request id is not an auth error).
 */
import { parseJsonLenient, parseNeedFiles, normalizeShape } from './response-doctor.js';

const BREAKER = new Map();
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

export function resetBreakers() {
  BREAKER.clear();
}

export function deadlineMs(output, task) {
  const t = String(task || '').toUpperCase();
  const envCode = Number(process.env.AI_TIMEOUT_CODE_MS || 0);
  const envJson = Number(process.env.AI_TIMEOUT_JSON_MS || 0);
  const envText = Number(process.env.AI_TIMEOUT_TEXT_MS || 0);
  if (output === 'files' || /CODE|GENERATE|BUILD|FILE/.test(t)) return envCode > 0 ? envCode : 240_000;
  if (output === 'json') return envJson > 0 ? envJson : 90_000;
  return envText > 0 ? envText : 60_000;
}

export function classifyError(err) {
  const msg = String(err?.message || err || '');
  const status = Number(err?.status || (/\bHTTP\s+(\d{3})\b/.exec(msg) || [])[1] || 0);
  if (err?.code === 'AI_NO_KEY' || /not configured|\bNO_KEY\b|no active ai key|no api key/i.test(msg)) return 'AI_NO_KEY';
  if (status === 401 || status === 403 || /INVALID_CREDENTIAL|API[_ ]KEY[_ ](?:NOT[_ ])?(?:INVALID|VALID)|unauthori[sz]ed|permission denied/i.test(msg)) return 'AI_AUTH';
  if (status === 402 || /insufficient (balance|quota|credit)|billing/i.test(msg)) return 'AI_QUOTA';
  if (status === 404 || /no longer available|model.*not (found|available)|MODEL_OR_ENDPOINT_UNAVAILABLE/i.test(msg)) return 'AI_MODEL_UNAVAILABLE';
  if (status === 429 || /\brate[ -]?limit|resource[_ ]exhausted|quota exceeded/i.test(msg)) return 'AI_RATE_LIMIT';
  if (err?.name === 'TimeoutError' || /\b(abort(ed)?|timed? ?out|timeout|deadline)\b/i.test(msg)) return 'AI_TIMEOUT';
  if ((status >= 500 && status < 600) || /UNAVAILABLE|overloaded|ECONN\w*|ENOTFOUND|fetch failed|network/i.test(msg)) return 'AI_UNAVAILABLE';
  if (/invalid json|malformed|could not parse/i.test(msg)) return 'AI_FORMAT';
  return 'AI_UNAVAILABLE';
}

const NO_RETRY = new Set(['AI_AUTH', 'AI_NO_KEY', 'AI_QUOTA', 'AI_MODEL_UNAVAILABLE', 'AI_TIMEOUT']);

export async function call(ai, {
  task = 'USER_CHAT',
  system = '',
  prompt = '',
  images = [],
  output = 'text',
  signal = null,
  projectId = null,
  modelRef = '',
  timeoutMs = 0,
} = {}) {
  if (!ai || typeof ai.complete !== 'function') {
    const e = new Error('AI is not configured. Open Settings and add a provider key.');
    e.code = 'AI_NO_KEY';
    throw e;
  }

  const json = output === 'json';
  const ms = timeoutMs > 0 ? timeoutMs : deadlineMs(output, task);

  const key = breakerKey(modelRef || 'hub', 'primary');
  if (breakerOpen(key)) {
    const e = new Error('AI provider temporarily paused after repeated failures. Try again in a minute.');
    e.code = 'AI_UNAVAILABLE';
    throw e;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) {
      const e = new Error('Cancelled');
      e.code = 'AI_CANCELLED';
      throw e;
    }
    // A fresh timeout per attempt: a timed-out first attempt must not abort the second one.
    const timeout = AbortSignal.timeout(ms);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const result = await ai.complete({
        task,
        system,
        prompt,
        json,
        images,
        signal: combined,
        cancelSignal: signal,
        timeoutMs: ms,
        projectId,
        modelRef: attempt === 1 ? modelRef : '',
      });
      breakerOk(key);
      return { ...result, text: result?.text ?? '', attempts: attempt, output };
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) {
        err.code = 'AI_CANCELLED';
        throw err;
      }
      const code = classifyError(err);
      err.code = err.code && err.code !== 'AI_UNAVAILABLE' ? err.code : code;
      err.aiClass = code;
      breakerFail(key);
      if (NO_RETRY.has(code) || /\bHTTP 400\b/.test(String(err.message || ''))) throw err;
      if (attempt >= 2) break;
      // transient (429 / 5xx / network): wait a little, then try once more (hub may route to another model)
      const wait = code === 'AI_RATE_LIMIT' ? Math.min(5000, 1500 * attempt) : 400 + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || Object.assign(new Error('AI unavailable'), { code: 'AI_UNAVAILABLE' });
}

function malformed(message, extra = {}) {
  return Object.assign(new Error(message), { code: 'AI_RESPONSE_MALFORMED', recoverable: true, ...extra });
}

/** Parse + normalize + validate an answer. Returns { ok, value, doctor, reason }. */
export function interpretJsonAnswer(raw, validateJson) {
  const text = String(raw?.text ?? '');
  let value = raw?.json ?? null;
  let doctor = null;
  if (value == null) {
    const parsed = parseJsonLenient(text);
    if (!parsed.ok) return { ok: false, reason: 'not-json', doctor: parsed };
    value = parsed.value;
    doctor = parsed;
  }
  value = normalizeShape(value);
  if (typeof validateJson === 'function') {
    let valid = false;
    try { valid = Boolean(validateJson(value)); } catch { valid = false; }
    if (!valid) return { ok: false, reason: 'schema', value, doctor };
  }
  return { ok: true, value, doctor };
}

export async function callJson(ai, opts = {}) {
  const { validateJson, allowNeedFiles = false, ...rest } = opts;
  const first = await call(ai, { ...rest, output: 'json' });
  const needs = allowNeedFiles ? parseNeedFiles(first.text) : [];
  const firstRead = interpretJsonAnswer(first, validateJson);
  if (firstRead.ok) return withDoctor(first, firstRead);
  if (allowNeedFiles && needs.length) return { ...first, json: firstRead.value ?? null, needFiles: needs };

  const truncated = isTruncated(first);
  const reminder = firstRead.reason === 'schema'
    ? 'Your previous JSON was valid but did not contain the required fields. Return exactly one JSON object that follows the contract above.'
    : (truncated
      ? 'Your previous answer was cut off. Return a SHORTER complete answer: exactly one valid JSON object, no markdown, only the files that must change.'
      : 'Your previous answer was not valid JSON. Return exactly one valid JSON object, no markdown, no commentary.');
  const retry = await call(ai, {
    ...rest,
    output: 'json',
    prompt: `${opts.prompt}\n\nJSON OUTPUT CONTRACT: ${reminder}`,
  });
  const retryNeeds = allowNeedFiles ? parseNeedFiles(retry.text) : [];
  const retryRead = interpretJsonAnswer(retry, validateJson);
  if (retryRead.ok) {
    const out = withDoctor(retry, retryRead);
    if (first.provider && retry.provider && first.provider !== retry.provider) out.fallbackFrom = first.provider;
    out.formatRetry = true;
    return out;
  }
  if (allowNeedFiles && retryNeeds.length) return { ...retry, json: retryRead.value ?? null, needFiles: retryNeeds };
  throw malformed(
    `AI response format was invalid. ${retry.provider || first.provider || 'The model'} did not return the required JSON. No files were changed.`,
    { provider: retry.provider || first.provider || null, truncated, reason: retryRead.reason },
  );
}

function isTruncated(r) {
  return /length|max_tokens|MAX_TOKENS/i.test(String(r?.finishReason || ''));
}

function withDoctor(result, read) {
  const out = { ...result, json: read.value };
  if (read.doctor && read.doctor.trace) {
    out.doctor = read.doctor.trace;
    if (read.doctor.repaired?.length) out.repaired = read.doctor.repaired;
    if (read.doctor.partial) { out.partial = true; out.salvaged = read.doctor.salvaged || null; }
  }
  return out;
}

export default { call, callJson, classifyError, deadlineMs, interpretJsonAnswer, resetBreakers };
