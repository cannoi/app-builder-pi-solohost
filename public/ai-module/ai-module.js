/**
 * Universal AI client for App Builder robot panel.
 * Uses relative URLs (same origin as the page) so SoloHost port mapping always works.
 * Prefers /api/panel/chat (Builder AIGateway) — same Gemini/DeepSeek/Hub as ⚙ Settings.
 */
window.UniversalAI = (() => {
  function apiRoot() {
    // Always relative — never hardcode host/port (SoloHost maps dynamic ports).
    if (typeof window !== 'undefined' && window.BUILDER_API_BASE) {
      return String(window.BUILDER_API_BASE).replace(/\/$/, '');
    }
    return '';
  }
  function url(path) {
    const p = path.startsWith('/') ? path : '/' + path;
    return apiRoot() + p;
  }
  async function json(path, options = {}) {
    const full = url(path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 60000);
    const opts = {
      credentials: 'same-origin',
      signal: ctrl.signal,
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    };
    delete opts.timeoutMs;
    let r;
    try {
      r = await fetch(full, opts);
    } catch (err) {
      clearTimeout(timer);
      const name = err?.name || '';
      const detail = name === 'AbortError'
        ? 'Request timed out'
        : (err.message || 'fetch failed');
      console.error('[UniversalAI] network error', full, err);
      throw new Error('Network error: ' + detail + ' → ' + full);
    }
    clearTimeout(timer);
    let j = {};
    try {
      j = await r.json();
    } catch {
      j = {};
    }
    if (!r.ok) {
      const msg = j.error || j.message || j.reply || `HTTP ${r.status}`;
      console.error('[UniversalAI] API error', full, r.status, msg);
      throw new Error(msg);
    }
    return j;
  }
  function create(opts = {}) {
    const history = [];
    const button = opts.button;
    if (button) button.addEventListener('click', () => opts.onOpen?.());
    return {
      apiRoot: apiRoot() || (typeof location !== 'undefined' ? location.origin : ''),
      async status() {
        try {
          return await json('/api/ai/status');
        } catch {
          // Fallback status from Builder hub
          try {
            const hub = await json('/api/ai/hub');
            const configured = (hub.connections || []).some((c) => c.status !== 'INVALID') || hub.configured;
            return { configured: Boolean(configured), source: 'builder-hub' };
          } catch {
            return { configured: false };
          }
        }
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
        const body = JSON.stringify({
          message,
          context,
          history: history.slice(-4),
          actions: extra.actions || [],
        });
        // 1) Builder-native path (same AI as main chat / Settings Gemini)
        let out;
        try {
          console.log('[UniversalAI] chat → /api/panel/chat', String(message).slice(0, 60));
          out = await json('/api/panel/chat', { method: 'POST', body, timeoutMs: 60000 });
        } catch (firstErr) {
          console.warn('[UniversalAI] panel/chat failed, trying /api/ai/chat', firstErr.message);
          try {
            out = await json('/api/ai/chat', { method: 'POST', body, timeoutMs: 60000 });
          } catch (secondErr) {
            throw firstErr.message && !/Not found|404/i.test(firstErr.message) ? firstErr : secondErr;
          }
        }
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
