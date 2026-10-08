/** Mount AI routes — Panel delegates to Builder AIGateway when available. */
function mountAIRoutes(router, ai, opts = {}) {
  const builderAI = opts.builderAI || null;
  const adapter = opts.adapter || null;
  const log = (level, msg, extra) => {
    try { ai?.log?.(level, msg, extra); } catch {}
    if (level === 'error') console.error('[ai-panel]', msg, extra || '');
    else console.log('[ai-panel]', msg, extra || '');
  };

  function builderConfigured() {
    try {
      return Boolean(builderAI && typeof builderAI.status === 'function' && builderAI.status()?.configured);
    } catch {
      return false;
    }
  }

  function builderPublicStatus() {
    if (!builderAI || typeof builderAI.status !== 'function') {
      return { ok: true, configured: false, settings: ai.publicSettings(), source: 'none' };
    }
    const st = builderAI.status() || {};
    const hub = st.hub || {};
    const preferred =
      hub.preferredProvider ||
      (st.gemini && 'gemini') ||
      (st.deepseek && 'deepseek') ||
      (st.primary || '') ||
      '';
    const model =
      hub.preferredModel ||
      st.geminiModel ||
      '';
    return {
      ok: true,
      configured: Boolean(st.configured),
      provider: preferred || (st.configured ? 'builder-hub' : 'none'),
      model: model || 'auto',
      settings: {
        provider: preferred || 'none',
        model: model || 'auto',
        mode: hub.mode || st.mode || 'AUTO',
        baseUrl: '',
        hasKey: Boolean(st.configured),
        maskedKey: st.configured ? 'builder-linked' : '',
        builderLinked: true,
        gemini: Boolean(st.gemini),
        deepseek: Boolean(st.deepseek),
        routing: st.routing || hub.mode || '',
      },
      source: 'builder-hub',
      hub: {
        mode: hub.mode,
        connections: Array.isArray(hub.connections)
          ? hub.connections.map((c) => ({
              id: c.id,
              provider: c.provider,
              status: c.status,
              models: (c.models || []).slice(0, 8),
            }))
          : [],
      },
    };
  }

  async function offlineGuide(message) {
    let reply =
      'App Builder — Pi SoloHost. Configure an AI provider in top ⚙ Settings (Gemini, DeepSeek, or Custom). The robot panel uses the same AI — no second key needed.';
    if (adapter && typeof adapter.localReply === 'function') {
      try {
        reply = (await adapter.localReply(String(message || ''), {})) || reply;
      } catch {}
    }
    // Never allow PAH identity text
    if (/Personal AI Hub is the shared AI gateway/i.test(reply)) {
      reply =
        'Xin chào! Đây là App Builder — Pi SoloHost. Mở ⚙ Settings để thêm Gemini/DeepSeek/Custom, rồi chat tại đây hoặc chat chính để Build app.';
    }
    return {
      ok: true,
      reply,
      actions: [],
      configured: false,
      provider: 'none',
      model: 'auto',
      source: 'local',
    };
  }

  router.get('/api/ai/status', (_req, res) => {
    if (builderConfigured()) return res.json(builderPublicStatus());
    res.json({
      ok: true,
      configured: ai.configured(),
      settings: ai.publicSettings(),
      source: 'panel-local',
    });
  });

  router.get('/api/ai/catalog', (_req, res) => {
    // Catalog stays useful for display; Builder hub is source of truth for active config
    res.json({ providers: ai.catalog(), note: 'Active provider is configured in Builder ⚙ Settings' });
  });

  router.get('/api/ai/settings', (_req, res) => {
    if (builderConfigured()) {
      const st = builderPublicStatus();
      return res.json({
        ...st.settings,
        readOnly: true,
        note: 'Panel uses Builder AI from top Settings. Change provider/key there — no second key in the panel.',
      });
    }
    res.json({ ...ai.publicSettings(), readOnly: false });
  });

  router.post('/api/ai/settings', (req, res) => {
    // When Builder AI is configured, panel settings are read-only view of Builder
    if (builderConfigured()) {
      return res.json({
        ok: true,
        settings: builderPublicStatus().settings,
        readOnly: true,
        message: 'AI is managed in Builder ⚙ Settings. Panel inherits that configuration.',
      });
    }
    try {
      res.json({ ok: true, settings: ai.saveSettings(req.body || {}) });
    } catch (e) {
      log('error', 'ai.settings', { error: e.message });
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  router.get('/api/ai/models', async (_req, res) => {
    if (builderConfigured()) {
      const st = builderPublicStatus();
      const models = [];
      for (const c of st.hub?.connections || []) {
        for (const m of c.models || []) models.push(typeof m === 'string' ? m : m.id || m);
      }
      if (st.model) models.unshift(st.model);
      return res.json({ ok: true, provider: st.provider, models: [...new Set(models)].slice(0, 40), source: 'builder-hub' });
    }
    try {
      res.json(await ai.refreshModels());
    } catch (e) {
      log('error', 'ai.models.refresh.fail', { error: e.message });
      res.status(502).json({ ok: false, error: safePublicError(e) });
    }
  });

  router.post('/api/ai/test', async (_req, res) => {
    if (builderConfigured()) {
      return res.json({
        ok: true,
        provider: builderPublicStatus().provider,
        message: 'Builder AI is configured. Use top Settings to test providers.',
        source: 'builder-hub',
      });
    }
    try {
      res.json(await ai.testConnection());
    } catch (e) {
      log('error', 'ai.provider.test.fail', { error: e.message });
      res.status(502).json({ ok: false, error: safePublicError(e), code: errorCode(e) });
    }
  });

  router.post('/api/ai/chat', async (req, res) => {
    try {
      const b = req.body || {};
      const message = String(b.message || '').trim();
      log('info', 'ai.chat.request', {
        hasMessage: Boolean(message),
        len: message.length,
        preview: message.slice(0, 80),
        builderConfigured: builderConfigured(),
      });
      if (!message) return res.status(400).json({ ok: false, error: 'message required' });

      // 1) PRIMARY: Builder AIGateway (same plane as main Builder chat)
      if (builderAI && typeof builderAI.complete === 'function' && builderConfigured()) {
        try {
          // Keep system prompt small for fast panel replies (coding tasks use full Builder prompts).
          let knowledge = String((adapter && adapter.knowledge) ||
            'App Builder — Pi SoloHost. Help Build/Run/Publish. Reply in user language. Be short.').trim();
          if (knowledge.length > 900) knowledge = knowledge.slice(0, 900);
          const hist = Array.isArray(b.history) ? b.history.slice(-4) : [];
          const histText = hist
            .map((h) => `${h.role || 'user'}: ${String(h.content || '').slice(0, 500)}`)
            .filter(Boolean)
            .join('\n');
          const prompt = histText ? `${histText}\nuser: ${message}` : message;
          const ctxBits = b.context && typeof b.context === 'object'
            ? Object.entries(b.context).slice(0, 6).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join('; ')
            : '';
          const system = [
            knowledge,
            'Robot panel. Concise. User language. Never invent Publish success.',
            ctxBits ? `Context: ${ctxBits}` : '',
          ].filter(Boolean).join('\n');

          const out = await builderAI.complete({
            task: 'USER_CHAT',
            prompt,
            system,
            json: false,
          });
          const reply = String(out?.text || out?.reply || out?.content || '').trim();
          if (!reply) {
            throw Object.assign(new Error('Empty AI response'), { code: 'EMPTY_RESPONSE' });
          }
          const provider = out?.provider || builderPublicStatus().provider || 'builder-hub';
          const model = out?.model || 'auto';
          log('info', 'ai.chat', { provider, model, source: 'builder-hub', replyLen: reply.length });
          return res.json({
            ok: true,
            reply,
            actions: [],
            configured: true,
            provider,
            model,
            source: 'builder-hub',
          });
        } catch (e) {
          // Transparent error — do NOT hide behind offline guide when Builder was configured
          log('error', 'ai.chat.builder_fail', { error: e.message, code: e.code || e.status });
          const safe = safePublicError(e);
          return res.status(502).json({
            ok: false,
            configured: true,
            source: 'builder-hub',
            error: `AI unavailable: ${safe}`,
            code: errorCode(e),
            reply: `AI unavailable: ${safe}`,
          });
        }
      }

      // 2) Optional panel-local provider only if Builder AI is NOT configured
      if (ai.configured && ai.configured()) {
        try {
          const out = await ai.chat({
            message,
            history: Array.isArray(b.history) ? b.history.slice(-8) : [],
            context: b.context || {},
          });
          log('info', 'ai.chat', { provider: out.provider, model: out.model, source: out.source || 'panel' });
          return res.json(out);
        } catch (e) {
          log('error', 'ai.chat.panel_fail', { error: e.message });
        }
      }

      // 3) Genuine offline guide only when no usable Builder AI
      const local = await offlineGuide(message);
      log('info', 'ai.chat', { source: 'local', offline: true });
      return res.json(local);
    } catch (e) {
      log('error', 'ai.chat.fail', { error: e.message });
      res.status(502).json({ ok: false, error: safePublicError(e), code: errorCode(e) });
    }
  });

  router.get('/api/logs', (_req, res) => res.json({ logs: ai.readLogs() }));
  router.delete('/api/logs', (_req, res) => {
    ai.clearLogs();
    res.json({ ok: true });
  });
}

function errorCode(e) {
  if (e.code === 'NO_MODEL') return 'NO_MODEL';
  if (e.code === 'TIMEOUT') return 'TIMEOUT';
  if (e.code === 'NETWORK') return 'NETWORK_ERROR';
  if (e.code === 'NOT_JSON') return 'BAD_BASE_URL';
  if (e.code === 'EMPTY_RESPONSE') return 'EMPTY_RESPONSE';
  return e.status === 401
    ? 'AUTH_ERROR'
    : e.status === 403
      ? 'FORBIDDEN'
      : e.status === 404
        ? 'MODEL_OR_ENDPOINT_NOT_FOUND'
        : e.status === 429
          ? 'RATE_LIMIT'
          : 'AI_PROVIDER_ERROR';
}

function safePublicError(e) {
  const s = String(e?.message || e || 'AI provider unavailable');
  return s
    .replace(/([?&](?:key|api_key|token|access_token)=[^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/pah_[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/cannoi_[a-zA-Z0-9]+/g, '[REDACTED]')
    .slice(0, 300);
}

module.exports = { mountAIRoutes };
