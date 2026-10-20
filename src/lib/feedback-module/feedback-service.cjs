/**
 * Universal SoloHost Feedback Hub server module (v1.3.0 standard).
 * IMPORTANT: ingest token never leaves this server / never returned by publicConfig.
 */
'use strict';

const DEFAULTS = {
  hubId: 'SHFH-CANNOI-0905428801',
  baseUrl: 'http://14.176.78.46:8090',
};

function createFeedbackService(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  // Token: opts (hub-config) → env → empty (caller must supply for POST)
  if (!cfg.ingestToken) {
    cfg.ingestToken = process.env.SHFH_INGEST_TOKEN || '';
  }
  const appId = opts.appId || process.env.SHFH_APP_ID || process.env.FEEDBACK_APP_ID || 'app';
  const appName = opts.appName || process.env.SHFH_APP_NAME || process.env.FEEDBACK_APP_NAME || 'Application';
  const version = opts.version || process.env.SHFH_APP_VERSION || '1.0.0';
  const base = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, '');
  const hubId = cfg.hubId || DEFAULTS.hubId;

  async function request(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (!cfg.ingestToken) throw new Error('Feedback Hub ingest token is not configured');
      headers.Authorization = 'Bearer ' + cfg.ingestToken;
    }
    const r = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Feedback Hub HTTP ${r.status}`);
    return j;
  }

  function publicConfig() {
    // Never include ingestToken / baseUrl secrets
    return { enabled: true, hubId, appId, appName, version };
  }

  async function sync(anonymousId) {
    const q = `?app_id=${encodeURIComponent(appId)}&version=${encodeURIComponent(version)}`;
    const nq = `?app_id=${encodeURIComponent(appId)}&anonymous_id=${encodeURIComponent(anonymousId || '')}`;
    const [policy, notices] = await Promise.all([
      request('GET', '/api/client-policy' + q),
      request('GET', '/api/notices' + nq),
    ]);
    return { ok: true, policy, notices: notices.items || [], donate: policy.donate || null };
  }

  async function send(payload) {
    return request('POST', '/api/feedback', payload);
  }

  async function markRead(id) {
    return request('POST', '/api/notices/' + encodeURIComponent(id) + '/read', {});
  }

  return { publicConfig, sync, send, markRead, appId, appName, version, hubId, baseUrl: base };
}

function mountFeedbackRoutes(router, fb) {
  router.get('/api/feedback/config', (_req, res) => res.json(fb.publicConfig()));
  router.get('/api/feedback/sync', async (req, res) => {
    try {
      res.json(await fb.sync(String(req.query.anonymous_id || '')));
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Feedback Hub unavailable' });
    }
  });
  router.post('/api/feedback', async (req, res) => {
    try {
      const b = req.body || {};
      const safe = { ...b, app_id: fb.appId, app_name: fb.appName, version: fb.version };
      delete safe.apiKey;
      delete safe.token;
      delete safe.password;
      delete safe.ingestToken;
      res.json(await fb.send(safe));
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Feedback Hub unavailable' });
    }
  });
  router.post('/api/feedback/read/:id', async (req, res) => {
    try {
      res.json(await fb.markRead(req.params.id));
    } catch {
      res.status(502).json({ ok: false });
    }
  });
}

module.exports = { createFeedbackService, mountFeedbackRoutes, DEFAULTS };
