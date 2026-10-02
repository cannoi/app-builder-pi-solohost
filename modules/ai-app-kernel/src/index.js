import { completeChat, listProviders, collectAvailableKeys, isLocalProvider, verifyProvider } from './providers.js';
import { createActionRegistry } from './actions.js';
import { createJsonFileStore, createMemoryStore, createCustomStore } from './store.js';
import { kernelTools, runTool } from './tools.js';
import { mountKernel } from './http.js';
import { createStickyRouter, modelsFor, detectProviderFromToken, discoverModels, discoverModelsDetailed, classifyProviderError, friendlyAiError, normalizeModel, PROVIDER_PRIORITY, keyBelongsToProvider } from './router.js';
import { logoPath } from './brand.js';

const SYSTEM = `You are the AI controller for this application.
Use tools to read the schema, inspect data, and call app actions.
Never invent collection names that are not in the schema.
Never expose API keys, tokens, or secrets.
Reply in the user's language.
Prefer smallest safe upgrade advice. Do not invent features.
After tool results, give a short status:
✅ Done
⚠️ Not completed
👤 User action`;

export function createAiKernel(options = {}) {
  const schema = options.schema || { name: 'app', collections: [] };
  const store = options.store || createMemoryStore();
  const actions = options.actions || createActionRegistry();
  const requestedProvider = options.provider || '';
  const requestedModel = options.model || '';
  const apiKey = options.apiKey || '';
  const baseUrl = options.baseUrl || '';
  const maxToolRounds = options.maxToolRounds || 6;
  const router = options.router || createStickyRouter({ stickyFile: options.stickyFile });

  async function resolveRoute() {
    const keys = collectAvailableKeys();
    if (apiKey) {
      const id = requestedProvider || process.env.AI_PROVIDER || detectProviderFromToken(apiKey);
      if (id && (isLocalProvider(id) || !detectProviderFromToken(apiKey) || detectProviderFromToken(apiKey) === id)) {
        keys[id] = apiKey;
      } else if (detectProviderFromToken(apiKey)) {
        keys[detectProviderFromToken(apiKey)] = apiKey;
      }
    }
    return router.resolve({
      requestedProvider,
      requestedModel,
      keys,
      localAvailable: Boolean(baseUrl || options.local),
    });
  }

  async function completeWithFallback({ system, messages, tools }) {
    const keys = collectAvailableKeys();
    if (apiKey) {
      const hinted = detectProviderFromToken(apiKey);
      const id = requestedProvider || process.env.AI_PROVIDER || hinted;
      if (id && (!hinted || hinted === id || isLocalProvider(id))) keys[id] = keys[id] || apiKey;
      else if (hinted) keys[hinted] = keys[hinted] || apiKey;
    }
    const route = await resolveRoute();
    const order = [...new Set([
      route.provider,
      ...PROVIDER_PRIORITY.filter((id) => Boolean(keys[id]) || (isLocalProvider(id) && (baseUrl || options.local))),
    ])];
    let lastErr;
    for (const provider of order) {
      const requested = normalizeModel(provider, requestedModel || process.env.AI_MODEL || '');
      const models = [...new Set([
        ...(requested ? [requested] : []),
        ...modelsFor(provider).map(m => normalizeModel(provider, m)),
      ].filter(Boolean))];
      const tried = new Set();
      const tryModel = async (model) => {
        const mid = normalizeModel(provider, model);
        if (!mid || tried.has(provider + ':' + mid)) return null;
        tried.add(provider + ':' + mid);
        try {
          const selected = String(process.env.AI_PROVIDER || '').toLowerCase();
          const boundKey = keys[provider]
            || (keyBelongsToProvider(apiKey, provider) ? apiKey : '')
            || (selected === provider && process.env.AI_API_KEY ? process.env.AI_API_KEY : '');
          if (!boundKey && !isLocalProvider(provider)) {
            lastErr = new Error(`No key bound to provider "${provider}"`);
            return lastErr;
          }
          const reply = await completeChat({
            provider,
            model: mid,
            apiKey: boundKey,
            baseUrl: isLocalProvider(provider) ? (baseUrl || undefined) : undefined,
            system, messages, tools,
          });
          await router.rememberSuccess(provider, reply.model || mid);
          return reply;
        } catch (err) {
          lastErr = err;
          await router.rememberFailure(provider, mid);
          return err;
        }
      };
      let stopProvider = false;
      for (const model of models) {
        const out = await tryModel(model);
        if (out && out.text !== undefined) return out;
        const cls = classifyProviderError(out || lastErr);
        if (!cls.retryModel) { stopProvider = !cls.retryProvider ? true : true; if (cls.kind === 'model') continue; break; }
      }
      if (!stopProvider) {
        const discovered = await discoverModels({
          provider,
          apiKey: keys[provider] || (keyBelongsToProvider(apiKey, provider) ? apiKey : ''),
          baseUrl: isLocalProvider(provider) ? (baseUrl || undefined) : undefined,
        }).catch(() => []);
        for (const model of discovered) {
          const out = await tryModel(model);
          if (out && out.text !== undefined) return out;
          const cls = classifyProviderError(out || lastErr);
          if (!cls.retryModel) break;
        }
      }
      const cls = classifyProviderError(lastErr);
      if (cls.kind === 'auth' && requestedProvider) break;
    }
    const friendly = friendlyAiError(lastErr);
    const e = new Error(friendly.text);
    e.kind = friendly.kind;
    throw e;
  }

  async function chat({ message, history = [], ctx = {} }) {
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: String(message || '') },
    ];
    const tools = kernelTools();
    const calls = [];
    for (let i = 0; i < maxToolRounds; i += 1) {
      const reply = await completeWithFallback({
        system: options.system || SYSTEM,
        messages,
        tools,
      });
      if (!reply.toolCalls.length) {
        return { text: reply.text, provider: reply.provider, model: reply.model, tools: calls };
      }
      for (const call of reply.toolCalls) {
        let result;
        try {
          result = await runTool(call.name, call.arguments || {}, { store, schema, actions, ctx });
        } catch (err) {
          result = { error: String(err.message || err) };
        }
        calls.push({ name: call.name, arguments: call.arguments, result });
        messages.push({ role: 'assistant', content: reply.text || `call ${call.name}` });
        messages.push({ role: 'user', content: `TOOL ${call.name} RESULT:\n${JSON.stringify(result).slice(0, 8000)}` });
      }
    }
    return { text: 'Stopped after tool limit. Ask again with a smaller request.', tools: calls };
  }

  return {
    schema,
    store,
    actions,
    providers: listProviders(),
    logoPath,
    route: resolveRoute,
    chat,
    invoke: (name, args, ctx) => actions.invoke(name, args, ctx),
    mount: (app, prefix, mountOptions = {}) => mountKernel(app, {
      ...mountOptions,
      prefix: prefix || mountOptions.prefix,
      kernel: {
        chat,
        schema,
        store,
        actions,
        route: resolveRoute,
        invoke: (name, args, ctx) => actions.invoke(name, args, ctx),
      },
    }),
  };
}

export {
  createActionRegistry,
  createJsonFileStore,
  createMemoryStore,
  createCustomStore,
  listProviders,
  mountKernel,
  createStickyRouter,
  collectAvailableKeys,
  isLocalProvider,
  detectProviderFromToken,
  discoverModels,
  discoverModelsDetailed,
  verifyProvider,
  keyBelongsToProvider,
  classifyProviderError,
  friendlyAiError,
  normalizeModel,
  logoPath,
};
