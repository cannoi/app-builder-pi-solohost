/**
 * Strict provider error classification — HTTP status + error.code first; regex last.
 * Never treat digits "401" inside a request id as AUTH_INVALID.
 */
export function classifyProviderError(err, status = 0) {
  const raw = err?.body || err?.response || err;
  let http = Number(status) || Number(err?.status) || Number(err?.statusCode) || 0;
  let providerCode = String(err?.code || err?.error?.code || raw?.error?.code || '').toUpperCase();
  let providerStatus = String(err?.error?.status || raw?.error?.status || '').toUpperCase();
  let message = String(err?.message || raw?.error?.message || raw?.message || err || '');
  let hint = '';

  // Parse JSON embedded in message
  try {
    const m = message.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      const e = j.error || j;
      if (e.message) message = String(e.message);
      if (e.code) providerCode = String(e.code).toUpperCase();
      if (e.status) providerStatus = String(e.status).toUpperCase();
      if (!http && e.code === 404) http = 404;
    }
  } catch { /* */ }

  if (!http) {
    const hm = message.match(/\bHTTP\s+(\d{3})\b/i);
    if (hm) http = Number(hm[1]);
  }

  // Suggested model from Google-style messages
  const sug = message.match(/use\s+([a-z0-9._-]+(?:-flash|-pro)?)/i)
    || message.match(/try\s+([a-z0-9._-]+)/i);
  if (sug) hint = sug[1];

  const authText = /\b(API[_ ]KEY[_ ]INVALID|UNAUTHENTICATED|invalid api key|API key not valid|incorrect api key|invalid.?credential)\b/i.test(message)
    || providerCode === 'API_KEY_INVALID'
    || providerStatus === 'UNAUTHENTICATED';
  if (http === 401 || authText) {
    return { code: 'AUTH_INVALID', class: 'AUTH_INVALID', user: 'API key is invalid.', hint, http, raw: message.slice(0, 240) };
  }

  if (http === 403 || providerCode === 'PERMISSION_DENIED' || /\bpermission denied\b|\bforbidden\b/i.test(message)) {
    return { code: 'PERMISSION', class: 'PERMISSION', user: 'This key cannot use that model.', hint, http, raw: message.slice(0, 240) };
  }

  const modelGone = http === 404
    || /no longer available|model.?not.?found|is not found|not found for API version|UNKNOWN_MODEL|NOT_FOUND/i.test(message)
    || providerCode === 'NOT_FOUND';
  if (modelGone) {
    return {
      code: 'MODEL_UNAVAILABLE',
      class: 'MODEL_UNAVAILABLE',
      user: hint
        ? `Model no longer available. Try ${hint}.`
        : 'That model is not available for this key.',
      hint,
      http,
      raw: message.slice(0, 240),
    };
  }

  if (http === 429 || /rate limit|resource_exhausted|too many requests/i.test(message) || providerCode === 'RESOURCE_EXHAUSTED') {
    const quota = /quota|billing|insufficient/i.test(message);
    return {
      code: quota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED',
      class: quota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED',
      user: quota ? 'Quota exhausted for this key.' : 'Rate limited — will try another model.',
      hint, http, raw: message.slice(0, 240),
    };
  }

  if (http === 503 || http === 502 || http === 504 || /overloaded|unavailable|temporar/i.test(message)) {
    return { code: 'OVERLOADED', class: 'OVERLOADED', user: 'Provider temporarily overloaded.', hint, http, raw: message.slice(0, 240) };
  }

  if (/MAX_TOKENS|finishReason.?LENGTH|output.?limit/i.test(message) || (/truncated/i.test(message) && !/timed out/i.test(message))) {
    return { code: 'TRUNCATED', class: 'TRUNCATED', user: 'AI response was truncated.', hint, http, raw: message.slice(0, 240) };
  }
  if (/SAFETY|blockReason|blocked|content.?filter/i.test(message)) {
    return { code: 'BLOCKED', class: 'BLOCKED', user: 'AI refused the request (safety/policy).', hint, http, raw: message.slice(0, 240) };
  }
  if (/stall|idle.?timeout|first.?token/i.test(message)) {
    return { code: 'STALLED', class: 'STALLED', user: 'AI model stopped responding.', hint, http, raw: message.slice(0, 240) };
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError|DEADLINE/i.test(message) || err?.code === 'DEADLINE') {
    return { code: 'TIMEOUT', class: 'TIMEOUT', user: 'AI request timed out.', hint, http, raw: message.slice(0, 240) };
  }

  if (/fetch failed|ECONNRESET|ENOTFOUND|network/i.test(message)) {
    return { code: 'NETWORK', class: 'NETWORK', user: 'Network error reaching the AI provider.', hint, http, raw: message.slice(0, 240) };
  }

  if (http === 400 || /bad request|invalid argument/i.test(message)) {
    return { code: 'BAD_REQUEST', class: 'BAD_REQUEST', user: 'Bad request to the AI provider.', hint, http, raw: message.slice(0, 240) };
  }

  // Legacy alias for callers still checking INVALID_CREDENTIAL
  const out = {
    code: 'UNKNOWN',
    class: 'UNKNOWN',
    user: message.slice(0, 180) || 'The AI provider request failed.',
    hint, http, raw: message.slice(0, 240),
  };
  // Compatibility
  if (out.code === 'AUTH_INVALID') out.code = 'AUTH_INVALID';
  return out;
}

/** @deprecated use class AUTH_INVALID — kept for older call sites */
export function isAuthError(cls) {
  return cls?.code === 'AUTH_INVALID' || cls?.code === 'INVALID_CREDENTIAL';
}

export function isTransient(code) {
  return ['RATE_LIMITED', 'OVERLOADED', 'NETWORK', 'TIMEOUT', 'STALLED', 'TRUNCATED', 'PROVIDER_TEMPORARY_ERROR', 'NETWORK_ERROR'].includes(code);
}

export function isModelUnavailable(code) {
  return code === 'MODEL_UNAVAILABLE' || code === 'MODEL_OR_ENDPOINT_UNAVAILABLE';
}

/** Localized short messages (en/vi). */
export function friendlyClassMessage(cls, lang = 'en') {
  const c = cls?.code || cls?.class || 'UNKNOWN';
  const vi = String(lang).toLowerCase().startsWith('vi');
  const map = {
    AUTH_INVALID: vi ? 'API key không hợp lệ.' : 'API key is invalid.',
    PERMISSION: vi ? 'Key không có quyền dùng model này.' : 'This key cannot use that model.',
    MODEL_UNAVAILABLE: vi
      ? (cls?.hint ? `Model không còn dùng được. Thử ${cls.hint}.` : 'Model không khả dụng.')
      : (cls?.hint ? `Model no longer available. Try ${cls.hint}.` : 'That model is not available.'),
    RATE_LIMITED: vi ? 'Bị giới hạn tốc độ — đang thử model khác.' : 'Rate limited — trying another model.',
    QUOTA_EXHAUSTED: vi ? 'Hết hạn mức API.' : 'Quota exhausted for this key.',
    OVERLOADED: vi ? 'Nhà cung cấp đang quá tải.' : 'Provider temporarily overloaded.',
    TIMEOUT: vi ? 'Hết thời gian chờ AI.' : 'AI request timed out.',
    STALLED: vi ? 'Model không phản hồi.' : 'AI model stopped responding.',
    TRUNCATED: vi ? 'Phản hồi AI bị cắt ngắn.' : 'AI response was truncated.',
    BLOCKED: vi ? 'AI từ chối yêu cầu (an toàn).' : 'AI refused the request (safety/policy).',
    EMPTY: vi ? 'AI trả về rỗng.' : 'AI returned an empty response.',
    FORMAT: vi ? 'AI trả về định dạng không hợp lệ.' : 'AI response format was invalid.',
    NETWORK: vi ? 'Lỗi mạng tới nhà cung cấp AI.' : 'Network error reaching the AI provider.',
    BAD_REQUEST: vi ? 'Yêu cầu gửi AI không hợp lệ.' : 'Bad request to the AI provider.',
    FORMAT: vi ? 'AI trả về định dạng không hợp lệ.' : 'AI response format was invalid.',
    UNKNOWN: vi ? 'Yêu cầu AI thất bại.' : 'The AI provider request failed.',
  };
  return map[c] || map.UNKNOWN;
}
