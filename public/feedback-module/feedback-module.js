/**
 * Universal Feedback client (server-proxied; no ingest token in browser).
 */
window.UniversalFeedback = (() => {
  const key = 'ufb_anon';
  function apiRoot() {
    if (window.BUILDER_API_BASE) return String(window.BUILDER_API_BASE).replace(/\/$/, '');
    return window.location.origin;
  }
  function anon() {
    let v = localStorage.getItem(key);
    if (!v) {
      v = crypto?.randomUUID?.() || Date.now() + '-' + Math.random();
      localStorage.setItem(key, v);
    }
    return v;
  }
  async function json(path, opts = {}) {
    const full = apiRoot() + (path.startsWith('/') ? path : '/' + path);
    let r;
    try {
      r = await fetch(full, {
        credentials: 'same-origin',
        ...opts,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) },
      });
    } catch (err) {
      console.error('[UniversalFeedback] network', full, err);
      throw new Error('Network error: ' + (err.message || 'fetch failed'));
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[UniversalFeedback] API', full, r.status, j);
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    return j;
  }
  function create(opts = {}) {
    const state = { sync: null, unread: 0 };
    const notify = () => opts.onUnread?.(state.unread);
    async function sync() {
      state.sync = await json('/api/feedback/sync?anonymous_id=' + encodeURIComponent(anon()));
      state.unread = (state.sync.notices || []).length;
      notify();
      opts.onSync?.(state.sync);
      return state.sync;
    }
    async function send(fields) {
      const payload = {
        event: 'feedback',
        type: fields.type || 'improvement',
        rating: Number(fields.rating) || 0,
        message: String(fields.message || '').slice(0, 2000),
        anonymous_id: anon(),
        locale: navigator.language || 'en',
      };
      return json('/api/feedback', { method: 'POST', body: JSON.stringify(payload) });
    }
    async function markRead(id) {
      const out = await json('/api/feedback/read/' + encodeURIComponent(id), { method: 'POST', body: '{}' });
      state.unread = Math.max(0, state.unread - 1);
      notify();
      return out;
    }
    return { sync, send, markRead, state };
  }
  return { create };
})();
