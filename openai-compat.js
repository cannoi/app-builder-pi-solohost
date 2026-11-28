/**
 * OpenAI-compatible API layer for SoloHost apps (Custom Provider).
 * Thin adapter over existing kernel — must be mounted BEFORE /v1 catch-all.
 */
import { randomUUID } from 'node:crypto';

function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      return '';
    }).join('');
  }
  return String(content);
}

function parseModel(model) {
  const raw = String(model || 'auto').trim();
  if (!raw || raw === 'auto' || raw === 'default') {
    return { provider: null, model: null, auto: true };
  }
  const m = raw.match(/^([a-z0-9_-]+)[/:|](.+)$/i);
  if (m) {
    const prov = m[1].toLowerCase();
    const known = ['local', 'ollama', 'openai', 'gemini', 'google', 'deepseek', 'groq', 'openrouter', 'anthropic', 'claude'];
    if (known.includes(prov)) {
      const map = { ollama: 'local', google: 'gemini', claude: 'anthropic' };
      return { provider: map[prov] || prov, model: m[2], auto: false };
    }
  }
  return { provider: null, model: raw, auto: false };
}

function messagesToPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let system = '';
  const transcript = [];
  for (const msg of list) {
    const role = String(msg?.role || 'user');
    const text = extractText(msg?.content).trim();
    if (!text) continue;
    if (role === 'system') system = system ? `${system}\n${text}` : text;
    else if (role === 'assistant') transcript.push(`Assistant: ${text}`);
    else transcript.push(`User: ${text}`);
  }
  const lastUser = [...list].reverse().find(m => m?.role === 'user');
  const message = lastUser ? extractText(lastUser.content).trim() : (transcript.join('\n') || 'Hello');
  const prior = transcript.slice(0, -1).join('\n');
  if (prior) system = system ? `${system}\n\nConversation so far:\n${prior}` : `Conversation so far:\n${prior}`;
  return { message, system };
}

function isBrowserSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // server-to-server typically has no Origin
  const host = req.get('host') || '';
  try {
    const o = new URL(origin);
    return o.host === host;
  } catch {
    return false;
  }
}

export function mountOpenAICompat(app, { kernel, serviceName = 'personal-ai-hub' }) {
  const asyncRoute = fn => (req, res) => Promise.resolve(fn(req, res)).catch(async err => {
    const message = String(err?.message || err);
    let status = err?.statusCode || err?.status || 400;
    if (/NO_ACTIVE_KEY|NO_PROVIDER|ALL_PROVIDERS/i.test(message)) status = 503;
    if (/INVALID_GATEWAY|AUTH/i.test(message)) status = 401;
    try {
      await kernel.logs.write('api.error', 'error', {
        path: req.path, method: req.method, error: message,
        appId: req.headers['x-solohost-app-id'] || null
      });
    } catch {}
    res.status(status >= 400 && status < 600 ? status : 400).json({
      error: {
        message,
        type: status === 401 ? 'invalid_request_error' : 'api_error',
        code: message.slice(0, 64),
        request_id: req.headers['x-request-id'] || null
      }
    });
  });

  /**
   * Gateway auth for /v1:
   * - No tokens configured yet → open (bootstrap)
   * - Tokens exist + Bearer/X-Personal-AI-Key present → validate
   * - Tokens exist + no key + same-origin browser → allow (Hub UI)
   * - Tokens exist + no key + server/external → 401
   */
  const gatewayAuth = async (req, res, next) => {
    try {
      const tokens = await kernel.gateway.listTokens();
      if (!tokens.length) return next();
      const hdr = req.headers['x-personal-ai-key']
        || (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1]
        || req.query?.api_key;
      if (!hdr) {
        if (isBrowserSameOrigin(req)) return next();
        return res.status(401).json({
          error: {
            message: 'Missing API key. Send Authorization: Bearer pah_… or X-Personal-AI-Key.',
            type: 'invalid_request_error',
            code: 'MISSING_GATEWAY_TOKEN'
          }
        });
      }
      const ok = await kernel.gateway.validate(hdr);
      if (!ok) {
        return res.status(401).json({
          error: {
            message: 'Invalid API key',
            type: 'invalid_request_error',
            code: 'INVALID_GATEWAY_TOKEN'
          }
        });
      }
      req.gatewayApp = ok;
      return next();
    } catch (e) {
      return res.status(500).json({
        error: { message: String(e?.message || e), type: 'api_error', code: 'AUTH_ERROR' }
      });
    }
  };

  // Public health — no auth
  app.get('/v1/health', asyncRoute(async (_req, res) => {
    const h = await kernel.health();
    res.json({
      status: 'ok',
      object: 'health',
      hub: 'healthy',
      local: !!h.local,
      localStatus: h.localStatus || null,
      localModels: h.localModels || 0,
      activeKeys: h.activeKeys,
      routingMode: h.routingMode || null,
      service: serviceName
    });
  }));

  app.get('/v1/models', gatewayAuth, asyncRoute(async (_req, res) => {
    const seen = new Set();
    const data = [];
    const push = (id, owned_by) => {
      const key = String(id);
      if (!key || seen.has(key)) return;
      seen.add(key);
      data.push({
        id: key,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: owned_by || 'personal-ai-hub',
        permission: [],
        root: key,
        parent: null
      });
    };

    push('auto', 'personal-ai-hub');

    // Live local Ollama models (even if no "local" key row)
    try {
      const localInfo = await kernel.local.models();
      if (localInfo?.available && Array.isArray(localInfo.models)) {
        for (const m of localInfo.models) {
          const name = typeof m === 'string' ? m : (m?.name || m?.model);
          if (!name) continue;
          push(name, 'local');
          push(`local/${name}`, 'local');
          push(`ollama/${name}`, 'local');
        }
      }
    } catch {}

    // Cloud / configured key models (skip hard-failed keys)
    try {
      const keys = await kernel.keys.listKeys();
      for (const k of keys) {
        if (k.status === 'INVALID' || k.status === 'BILLING_REQUIRED') continue;
        if (k.provider === 'local') continue; // already from live local
        for (const m of k.models || []) {
          push(m, k.provider);
          push(`${k.provider}/${m}`, k.provider);
        }
      }
    } catch {}

    res.json({ object: 'list', data });
  }));

  app.post('/v1/chat/completions', gatewayAuth, asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (body.stream === true) {
      return res.status(400).json({
        error: {
          message: 'stream=true is not supported yet; use stream=false',
          type: 'invalid_request_error',
          code: 'STREAM_NOT_SUPPORTED'
        }
      });
    }

    const parsed = parseModel(body.model);
    const { message, system } = messagesToPrompt(body.messages);
    if (!message) {
      return res.status(400).json({
        error: { message: 'messages required', type: 'invalid_request_error', code: 'MESSAGES_REQUIRED' }
      });
    }

    const requestId = req.headers['x-request-id'] || `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const appId = req.headers['x-solohost-app-id'] || req.gatewayApp?.name || body.user || null;
    const started = Date.now();

    const result = await kernel.chat({
      message,
      system: system || undefined,
      provider: parsed.provider || undefined,
      model: parsed.model || undefined,
      requestId,
      appId
    });

    const latency = Date.now() - started;
    const modelOut = result.model || body.model || 'auto';
    const content = result.reply || '';

    res.json({
      id: requestId.startsWith('chatcmpl-') ? requestId : `chatcmpl-${requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelOut,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      personal_ai_hub: {
        provider: result.provider || null,
        keyId: result.keyId || null,
        requestId: result.requestId || requestId,
        latencyMs: latency,
        appId
      }
    });
  }));

  app.get('/v1/chat/completions', (_req, res) => {
    res.status(405).json({
      error: { message: 'Use POST /v1/chat/completions', type: 'invalid_request_error', code: 'METHOD_NOT_ALLOWED' }
    });
  });
}
