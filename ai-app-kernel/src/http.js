export function mountKernel(app, { prefix = '/ai', kernel }) {
  const asyncRoute = fn => (req, res) => Promise.resolve(fn(req, res)).catch(async err => {
    const message = String(err?.message || err);
    try {
      await kernel.logs.write('api.error', 'error', {
        path: req.path, method: req.method, error: message,
        appId: req.headers['x-solohost-app-id'] || null
      });
    } catch {}
    res.status(err?.statusCode || 400).json({
      error: message,
      requestId: req.headers['x-request-id'] || null
    });
  });

  // Optional gateway token: if any tokens exist, require X-Personal-AI-Key / Authorization for /chat.
  // Hub UI uses same-origin without token (browser). External apps should send a gateway token.
  const optionalGatewayAuth = async (req, res, next) => {
    try {
      const tokens = await kernel.gateway.listTokens();
      if (!tokens.length) return next(); // open until first gateway token is created
      const hdr = req.headers['x-personal-ai-key']
        || (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1]
        || req.body?.gatewayToken;
      // Same-origin Hub UI calls may omit token; only enforce when caller looks external
      // and a token header is expected. Soft mode: if header present, validate; if absent, allow.
      if (!hdr) return next();
      const ok = await kernel.gateway.validate(hdr);
      if (!ok) return res.status(401).json({ error: 'INVALID_GATEWAY_TOKEN' });
      req.gatewayApp = ok;
      return next();
    } catch (e) {
      return next();
    }
  };

  app.get(`${prefix}/health`, asyncRoute(async (_req, res) => res.json(await kernel.health())));
  app.get(`${prefix}/routing`, asyncRoute(async (_req, res) => res.json(await kernel.routing.get())));
  app.post(`${prefix}/routing`, asyncRoute(async (req, res) => res.json(await kernel.routing.set(req.body?.mode))));
  app.get(`${prefix}/diagnostics`, asyncRoute(async (_req, res) => res.json(await kernel.diagnostics())));
  app.get(`${prefix}/providers`, asyncRoute(async (_req, res) => res.json({ providers: await kernel.keys.providers() })));
  app.get(`${prefix}/keys`, asyncRoute(async (req, res) => res.json({ keys: await kernel.keys.listKeys(req.query.provider) })));
  app.post(`${prefix}/keys`, asyncRoute(async (req, res) => res.status(201).json(await kernel.keys.addKey(req.body || {}))));
  app.post(`${prefix}/keys/:id/test`, asyncRoute(async (req, res) => res.json(await kernel.keys.verifyKey(req.params.id))));
  app.delete(`${prefix}/keys/:id`, asyncRoute(async (req, res) => res.json(await kernel.keys.removeKey(req.params.id))));

  app.post(`${prefix}/chat`, optionalGatewayAuth, asyncRoute(async (req, res) => {
    const body = {
      ...(req.body || {}),
      appId: req.headers['x-solohost-app-id'] || req.gatewayApp?.name || req.body?.appId || null
    };
    res.json(await kernel.chat(body));
  }));

  app.post(`${prefix}/act`, asyncRoute(async (req, res) =>
    res.json(await kernel.actions.invoke(req.body?.name, req.body?.args || {}, {
      requestId: req.headers['x-request-id'],
      appId: req.headers['x-solohost-app-id'] || null
    }))
  ));

  app.get(`${prefix}/logs`, asyncRoute(async (req, res) =>
    res.json({ logs: await kernel.logs.list({ limit: Number(req.query.limit) || 200 }) })
  ));
  app.delete(`${prefix}/logs`, asyncRoute(async (_req, res) => {
    await kernel.logs.clear();
    res.json({ success: true });
  }));

  app.get(`${prefix}/memory`, asyncRoute(async (req, res) =>
    res.json({ memory: await kernel.memory.list(Number(req.query.limit) || 100) })
  ));
  app.delete(`${prefix}/memory`, asyncRoute(async (_req, res) => res.json(await kernel.memory.clear())));
  app.get(`${prefix}/memory/training`, asyncRoute(async (req, res) =>
    res.json(await kernel.memory.trainingExport(Number(req.query.limit) || 200))
  ));
  app.delete(`${prefix}/memory/training`, asyncRoute(async (_req, res) =>
    res.json(await kernel.memory.clearTraining())
  ));

  app.get(`${prefix}/local/models`, asyncRoute(async (req, res) =>
    res.json(await kernel.local.models({ force: req.query.force === '1' || req.query.force === 'true' }))
  ));
  app.post(`${prefix}/local/models/pull`, asyncRoute(async (req, res) =>
    res.json(await kernel.local.pull(req.body?.name))
  ));
  app.post(`${prefix}/local/base-url`, asyncRoute(async (req, res) =>
    res.json(await kernel.local.setBaseUrl(req.body?.url || req.body?.baseUrl || ''))
  ));

  // Gateway tokens for SoloHost apps calling this Hub
  app.get(`${prefix}/gateway/tokens`, asyncRoute(async (_req, res) =>
    res.json({ tokens: await kernel.gateway.listTokens() })
  ));
  app.post(`${prefix}/gateway/tokens`, asyncRoute(async (req, res) =>
    res.status(201).json(await kernel.gateway.createToken(req.body || {}))
  ));
  app.delete(`${prefix}/gateway/tokens/:id`, asyncRoute(async (req, res) =>
    res.json(await kernel.gateway.revokeToken(req.params.id))
  ));
}
