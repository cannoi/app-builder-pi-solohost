export function classifyProviderError(err, status = 0) {
  const msg = String(err?.message || err || '');
  const code = Number(status) || Number((msg.match(/HTTP (\d{3})/) || [])[1] || 0);
  if (/invalid.?api.?key|incorrect api key|401|unauthorized|invalid.?credential/i.test(msg) || code === 401) {
    return { code: 'INVALID_CREDENTIAL', user: 'API key is invalid.' };
  }
  if (code === 403 || /permission denied|forbidden/i.test(msg)) {
    return { code: 'PERMISSION_DENIED', user: 'This credential cannot use that model.' };
  }
  if (code === 404 || /model.?not.?found|not found|unknown model/i.test(msg)) {
    return { code: 'MODEL_OR_ENDPOINT_UNAVAILABLE', user: 'That model or endpoint is not available for this key.' };
  }
  if (code === 429 || /rate limit|too many requests|resource exhausted/i.test(msg)) {
    return { code: 'RATE_LIMITED', user: 'The provider is rate-limited. Trying another verified model if available.' };
  }
  if (code >= 500 || /503|502|504|overloaded|unavailable|temporar/i.test(msg)) {
    return { code: 'PROVIDER_TEMPORARY_ERROR', user: 'The provider is temporarily unavailable.' };
  }
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|network|timeout/i.test(msg)) {
    return { code: 'NETWORK_ERROR', user: 'Network error reaching the AI provider.' };
  }
  return { code: 'UNKNOWN_PROVIDER_ERROR', user: msg.slice(0, 180) || 'The AI provider request failed.' };
}

export function isTransient(code) {
  return ['RATE_LIMITED', 'PROVIDER_TEMPORARY_ERROR', 'NETWORK_ERROR'].includes(code);
}
