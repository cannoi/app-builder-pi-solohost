/**
 * Universal AI client for App Builder panel.
 * Uses window.location.origin; credentials included for access-password cookie.
 */
window.UniversalAI = (() => {
  function apiRoot() {
    if (typeof window !== 'undefined' && window.BUILDER_API_BASE) {
      return String(window.BUILDER_API_BASE).replace(/\/$/, '');
    }
    try {
      return window.location.origin;
    } catch {
      return '';
    }
  }
  function url(path) {
    const p = path.startsWith('/') ? path : '/' + path;
    return apiRoot() + p;
  }
  function authHeaders() {
    return { 'Content-Type': 'application/json', Accept: 'application/json' };
  }
  async function json(path, options = {}) {
    const full = url(path);
    const opts = {
      credentials: 'same-origin',
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    };
    let r;
    try {
      r = await fetch(full, opts);
    } catch (err) {
      console.error('[UniversalAI] network error', full, err);
      throw new Error('Network error: ' + (err.message || 'fetch failed') + ' → ' + full);
    }
    let j = {};
    try {
      j = await r.json();
    } catch {
      j = {};
    }
    if (!r.ok) {
      const msg = j.error || j.message || `HTTP ${r.status}`;
      console.error('[UniversalAI] API error', full, r.status, msg, j);
      throw new Error(msg);
    }
    return j;
  }
  function create(opts = {}) {
    const history = [];
    const button = opts.button;
    if (button) button.addEventListener('click', () => opts.onOpen?.());
    return {
      apiRoot: apiRoot(),
      async status() {
        return json('/api/ai/status');
      },
      async settings() {
        return json('/api/ai/settings');
      },
      async models() {
        return json('/api/ai/models');
      },
      async testConnection() {
        return json('/api/ai/test', { method: 'POST', body: '{}' });
      },
      async saveSettings(v) {
        return json('/api/ai/settings', { method: 'POST', body: JSON.stringify(v || {}) });
      },
      async catalog() {
        return json('/api/ai/catalog');
      },
      async chat(message, context = {}, extra = {}) {
        console.log('[UniversalAI] chat →', apiRoot() + '/api/ai/chat', String(message).slice(0, 60));
        const out = await json('/api/ai/chat', {
          method: 'POST',
          body: JSON.stringify({
            message,
            context,
            history: history.slice(-4),
            actions: extra.actions || [],
          }),
        });
        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: out.reply || '' });
        while (history.length > 8) history.splice(0, 2);
        if (Array.isArray(out.actions)) opts.onActions?.(out.actions);
        return out;
      },
      clearHistory() {
        history.length = 0;
      },
      history,
    };
  }
  return { create, apiRoot, url };
})();
