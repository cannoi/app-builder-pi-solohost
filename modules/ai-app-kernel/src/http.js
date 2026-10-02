import { createReadStream, existsSync } from 'node:fs';
import { logoPath } from './brand.js';
import { filterSchema } from './tools.js';

export function mountKernel(app, { prefix = '/ai', kernel, authorize = null }) {
  const route = (method, path, handler, options = {}) => {
    if (typeof app[method] === 'function') app[method](prefix + path, wrap(handler, options.publicRoute ? null : authorize));
  };
  route('get', '/health', async () => ({ ok: true, module: 'ai-app-kernel' }), { publicRoute: true });
  route('get', '/schema', async () => {
    const schema = filterSchema(kernel.schema);
    return { schema, collections: schema.collections.map((item) => item.name) };
  });
  route('get', '/capabilities', async () => ({ actions: kernel.actions.list() }));
  route('get', '/route', async () => (kernel.route ? kernel.route() : { provider: 'auto' }));
  route('post', '/chat', async (req) => kernel.chat({
    message: req.body?.message || req.body?.text,
    history: req.body?.history || [],
    ctx: req.body?.ctx || {},
  }));
  route('post', '/act', async (req) => {
    const body = req.body || {};
    const name = body.name;
    const args = body.args || {};
    const ctx = body.ctx || {};
    if (typeof kernel.invoke === 'function') return kernel.invoke(name, args, ctx);
    if (kernel.actions && typeof kernel.actions.invoke === 'function') return kernel.actions.invoke(name, args, ctx);
    throw new Error('Kernel invoke is not mounted');
  });

  const logoUrl = `${prefix}/logo.png`;
  if (typeof app.get === 'function') {
    app.get(logoUrl, (_req, res) => {
      if (!existsSync(logoPath)) {
        if (res?.status) return res.status(404).json({ error: 'logo missing' });
        return;
      }
      if (res?.setHeader) res.setHeader('Content-Type', 'image/png');
      if (res?.setHeader) res.setHeader('Cache-Control', 'public, max-age=86400');
      createReadStream(logoPath).pipe(res);
    });
  }

  return app;
}

export function aiButtonHtml({ prefix = '/ai', label = 'AI' } = {}) {
  const src = `${prefix}/logo.png`;
  return `<button type="button" class="ai-kernel-btn" aria-label="${label}" title="${label}">
  <img src="${src}" alt="${label}" width="36" height="36" />
</button>`;
}

function wrap(handler, authorize) {
  return async (req, res) => {
    try {
      if (!authorize) {
        if (res?.status) return res.status(503).json({ error: 'AI Kernel routes require the host app authorization callback.' });
        throw new Error('AI Kernel routes require the host app authorization callback.');
      }
      if (await authorize(req) !== true) {
        if (res?.status) return res.status(401).json({ error: 'Authentication required.' });
        throw new Error('Authentication required.');
      }
      const out = await handler(req);
      if (res?.json) return res.json(out);
      return out;
    } catch (err) {
      const msg = String(err.message || err);
      const status = err.kind === 'auth' || err.kind === 'billing' ? 502 : 400;
      if (res?.status) return res.status(status).json({ error: msg, kind: err.kind || 'error' });
      throw err;
    }
  };
}
