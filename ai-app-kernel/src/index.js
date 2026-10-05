import crypto from 'node:crypto';
import { mountKernel } from './http.js';
import { createSecretVault } from './vault.js';
import { createActivityLogger } from './logger.js';
import { providerCatalog, listModels, chatProvider, isChatCapableModel, rankChatModels } from './providers.js';
import { createLocalModelManager } from './local.js';

export function createAiKernel(options = {}) {
  const schema = options.schema || { name: 'app', collections: [] };
  const store = options.store || {};
  const actions = options.actions || {};
  const baseFetch = options.fetchImpl || fetch;
  const fetchImpl = async (url, init = {}) => {
    const timeoutMs = Number(init.timeoutMs || options.requestTimeoutMs || 45000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const next = { ...init, signal: init.signal || controller.signal };
      delete next.timeoutMs;
      return await baseFetch(url, next);
    } catch (err) {
      if (err?.name === 'AbortError') {
        const e = new Error(`REQUEST_TIMEOUT_${timeoutMs}MS`);
        e.status = 504;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  const providers = providerCatalog(options.providers || {});
  const vault = createSecretVault(options.vaultFile || './data/ai-vault.json', options.masterFile || './data/.ai-master-key');
  const logger = createActivityLogger(options.logFile || './data/activity-log.json');
  const stateFile = options.stateFile || './data/ai-state.json';
  let state = null;
  const local = createLocalModelManager(providers.local, fetchImpl);
  let lastLocalFailLog = 0;

  async function loadState() {
    if (state) return state;
    try {
      state = JSON.parse(await (await import('node:fs/promises')).readFile(stateFile, 'utf8'));
      state.memory ||= [];
      state.keys ||= [];
      state.models ||= {};
      state.routing ||= {};
      state.config ||= {};
      state.training ||= [];
      state.gatewayTokens ||= [];
      state.config.routingMode ||= 'balanced';
      state.keys = state.keys.map(k => ({
        retryAt: 0,
        useCount: 0,
        models: [],
        ...k,
        models: (k.models || []).filter(isChatCapableModel)
      }));
    } catch {
      state = { keys: [], models: {}, memory: [], routing: {}, config: {}, training: [], gatewayTokens: [] };
    }
    // Virtual local key only when user has not opted out (config.localKeyEnabled !== false)
    // and no local key exists yet. Do not recreate after explicit delete.
    if (
      providers.local &&
      state.config?.localKeyEnabled !== false &&
      state.config?.localKeyRemoved !== true &&
      !state.keys.some(k => k.provider === 'local')
    ) {
      state.keys.push({
        id: 'local-default',
        provider: 'local',
        masked: 'LOCAL',
        status: 'TEST_REQUIRED',
        models: [],
        selectedModel: null,
        createdAt: new Date().toISOString(),
        lastChecked: null,
        lastUsed: null,
        lastError: null,
        retryAt: 0,
        useCount: 0
      });
      await saveState();
    }
    return state;
  }

  async function saveState() {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  const publicKey = k => ({
    id: k.id,
    provider: k.provider,
    masked: k.masked,
    status: k.status,
    models: k.models || [],
    selectedModel: k.selectedModel || null,
    lastChecked: k.lastChecked || null,
    lastUsed: k.lastUsed || null,
    lastError: k.lastError || null,
    createdAt: k.createdAt,
    useCount: k.useCount || 0
  });
  const providerInfo = p => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, defaultModels: p.models || [] });

  function keyRank(a, b) {
    return (a.useCount || 0) - (b.useCount || 0)
      || String(a.lastUsed || '').localeCompare(String(b.lastUsed || ''))
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  }

  function rankModels(list, preferred = null) {
    return rankChatModels(list, preferred);
  }

  async function chooseKeys(provider, model, allowProviderFallback = true) {
    await loadState();
    const now = Date.now();
    const mode = state.config?.routingMode || 'balanced';
    const usable = k =>
      (k.status === 'ACTIVE' || (k.status === 'ERROR' && (k.models || []).length > 0 && (!k.retryAt || k.retryAt <= now)))
      && (!k.retryAt || k.retryAt <= now || k.status === 'ACTIVE');

    let pool = state.keys.filter(usable);
    // Routing policies
    if (provider === 'local' || mode === 'local_only') {
      pool = pool.filter(k => k.provider === 'local');
    } else if (mode === 'cloud' && !provider) {
      pool = pool.filter(k => k.provider !== 'local');
    } else if (provider) {
      pool = pool.filter(k => k.provider === provider);
    }

    pool = pool.filter(k => !model || (k.models || []).includes(model) || k.selectedModel === model);

    // prefer_local: local keys first
    if (!provider && mode === 'prefer_local') {
      pool = [
        ...pool.filter(k => k.provider === 'local').sort(keyRank),
        ...pool.filter(k => k.provider !== 'local').sort(keyRank)
      ];
      return pool;
    }

    pool = pool.sort(keyRank);
    if (pool.length || !provider || !allowProviderFallback || mode === 'local_only') return pool;

    // fallback to other providers when requested provider empty (balanced / prefer_local)
    if (mode === 'local_only') return [];
    return state.keys
      .filter(usable)
      .filter(k => !provider || k.provider !== provider)
      .filter(k => mode !== 'cloud' || k.provider !== 'local')
      .filter(k => !k.retryAt || k.retryAt <= now)
      .sort(keyRank);
  }

  async function activatePendingKeys(provider, model, requestId) {
    await loadState();
    const pending = state.keys.filter(k =>
      (k.status === 'TEST_REQUIRED' || k.status === 'ERROR' || k.status === 'COOLDOWN')
      && (!provider || k.provider === provider)
      && (!model || !k.models?.length || k.models.includes(model) || k.selectedModel === model)
    );
    for (const k of pending.slice(0, 5)) {
      await logger.write('token.auto_verify.start', 'info', { requestId, provider: k.provider, keyId: k.id });
      const checked = await kernel.keys.verifyKey(k.id);
      if (checked.status === 'ACTIVE') {
        await logger.write('token.auto_verify.success', 'info', {
          requestId, provider: k.provider, keyId: k.id, modelCount: checked.models?.length || 0
        });
      } else {
        await logger.write('token.auto_verify.failed', 'warn', {
          requestId, provider: k.provider, keyId: k.id, status: checked.status, error: checked.lastError
        });
      }
    }
    return chooseKeys(provider, model, !provider);
  }

  const kernel = {
    schema, store, actions, providers,

    async chat({ message, provider, model, system, appId, strictProvider = false }) {
      const requestId = crypto.randomUUID();
      if (!message?.trim()) throw Object.assign(new Error('MESSAGE_REQUIRED'), { statusCode: 400 });

      await logger.write('chat.request', 'info', {
        requestId, provider, model, appId: appId || 'hub-ui', messageLength: String(message).length
      });

      let eligible = await chooseKeys(provider, model, !provider && !strictProvider);
      if (!eligible.length) eligible = await activatePendingKeys(provider, model, requestId);
      if (!eligible.length && !provider && !strictProvider) eligible = await chooseKeys(null, null, true);

      if (!eligible.length) {
        await logger.write('chat.failed', 'warn', {
          requestId, reason: 'NO_ACTIVE_KEY', provider, model,
          available: state.keys.filter(k => !provider || k.provider === provider)
            .map(k => ({ provider: k.provider, status: k.status, keyId: k.id, lastError: k.lastError }))
        });
        return {
          reply: '',
          error: 'NO_ACTIVE_KEY',
          message: 'No usable AI key is available. Open Settings → Activity Log for the exact provider/key error, then Test / refresh models on a key.',
          needsUserAction: true,
          requestId
        };
      }

      await loadState();
      const memories = state.memory.slice(-10).map(x => `${x.role}: ${x.content}`).join('\n');
      const contextSystem = [
        system || 'You are a helpful private Personal AI Hub assistant. Be concise and useful. Reply in the user language.',
        memories ? `Relevant recent private interaction memory:\n${memories}` : ''
      ].filter(Boolean).join('\n\n');

      const failures = [];
      for (const k of eligible) {
        const p = providers[k.provider];
        if (!p) continue;

        // Prefer sticky + discovered models only. Catalog defaults are last-resort
        // when the key has no discovered list (avoids 404 on removed models like Groq llama-3.1-8b-instant).
        const preferred = k.selectedModel || null;
        let candidates = [];
        if (model) candidates.push(model);
        const discovered = k.models || [];
        if (discovered.length) candidates.push(...discovered);
        else candidates.push(...(p.models || []));
        candidates = rankModels(candidates, preferred);
        if (model) candidates = [model, ...candidates.filter(m => m !== model)];

        if (!candidates.length) {
          failures.push({ provider: k.provider, reason: 'NO_MODEL' });
          continue;
        }

        let chosen = candidates[0];
        try {
          const token = k.provider === 'local' ? '' : await vault.get(k.id);
          if (k.provider !== 'local' && !token) throw new Error('TOKEN_NOT_FOUND');

          let result = null;
          let lastModelError = null;
          let quotaHits = 0;
          const maxTry = Math.min(candidates.length, 8);
          for (let i = 0; i < maxTry; i++) {
            chosen = candidates[i];
            try {
              await logger.write('chat.attempt', 'info', { requestId, provider: k.provider, model: chosen, keyId: k.id });
              if (k.provider === 'local') {
                const live = local.baseUrl?.() || providers.local?.baseUrl;
                if (live) p.baseUrl = live;
              }
              result = await chatProvider(
                p, token, chosen,
                [{ role: 'system', content: contextSystem }, { role: 'user', content: message }],
                fetchImpl
              );
              const reply = String(result.reply || '').trim();
              if (!reply) {
                const e = new Error('PROVIDER_EMPTY_RESPONSE');
                e.status = 502;
                throw e;
              }
              break;
            } catch (candidateErr) {
              lastModelError = candidateErr;
              // Auth / billing on the KEY — stop this key entirely.
              if (candidateErr.status === 401 || candidateErr.status === 403) throw candidateErr;
              // Local CPU timeout: keep trying other models/keys; do not treat as auth failure.
              if (/REQUEST_TIMEOUT/i.test(String(candidateErr.message || '')) || candidateErr.status === 504) {
                await logger.write('model.unavailable', 'warn', {
                  requestId, provider: k.provider, model: chosen, keyId: k.id,
                  status: 504, suggestedModel: null, error: safeError(candidateErr)
                });
                continue;
              }
              if (candidateErr.status === 402) throw candidateErr;

              // 429 is often PER-MODEL on free tiers (Gemini). Keep trying cheaper models
              // instead of locking the whole key like the previous buggy path.
              if (candidateErr.status === 429) {
                quotaHits += 1;
                k.models = (k.models || []).filter(m => m !== chosen);
                await logger.write('model.quota', 'warn', {
                  requestId, provider: k.provider, model: chosen, keyId: k.id,
                  status: 429, error: safeError(candidateErr)
                });
                continue;
              }

              // 404 / empty / transient: rotate model, parse Gemini "use models/X" hint.
              const suggested = extractModelHint(candidateErr.message || candidateErr.body || '');
              if (suggested && isChatCapableModel(suggested) && !candidates.includes(suggested)) {
                candidates.push(suggested);
              }
              if (candidateErr.status === 404) {
                k.models = (k.models || []).filter(m => m !== chosen);
              }
              await logger.write('model.unavailable', 'warn', {
                requestId, provider: k.provider, model: chosen, keyId: k.id,
                status: candidateErr.status || null, suggestedModel: suggested || null, error: safeError(candidateErr)
              });
              // If user forced a specific model, don't silently rotate away from it more than once.
              if (model && chosen === model && candidateErr.status !== 404) throw candidateErr;
            }
          }
          if (!result) {
            // Cool down the key only when quota exhausted across tried models.
            if (quotaHits > 0 && quotaHits >= Math.min(maxTry, 3)) {
              const e = lastModelError || new Error('PROVIDER_QUOTA_ALL_MODELS');
              e.status = 429;
              throw e;
            }
            throw lastModelError || new Error('PROVIDER_NO_USABLE_MODEL');
          }

          const reply = String(result.reply || '').trim();
          const now = new Date().toISOString();
          k.lastUsed = now;
          k.lastError = null;
          k.status = 'ACTIVE';
          k.useCount = (k.useCount || 0) + 1;
          k.retryAt = 0;
          // Sticky preferred model (pinode-telegram rememberGeminiSuccess)
          k.selectedModel = result.model || chosen;
          if (result.model && isChatCapableModel(result.model)) {
            k.models = rankModels([result.model, ...(k.models || [])], result.model);
          }

          state.memory.push({ role: 'user', content: message, ts: now, provider: k.provider, model: result.model, requestId });
          state.memory.push({ role: 'assistant', content: reply, ts: new Date().toISOString(), provider: k.provider, model: result.model, requestId });
          state.memory = state.memory.slice(-200);

          // Training pairs for local AI self-learning (cloud → local knowledge transfer)
          if (k.provider !== 'local') {
            state.training = state.training || [];
            state.training.push({
              id: requestId,
              ts: now,
              provider: k.provider,
              model: result.model,
              user: message,
              assistant: reply
            });
            state.training = state.training.slice(-500);
          }

          await saveState();
          await logger.write('chat.success', 'info', {
            requestId, provider: k.provider, model: result.model, keyId: k.id,
            appId: appId || 'hub-ui', responseLength: reply.length
          });
          return { ...result, reply, provider: k.provider, keyId: k.id, requestId };
        } catch (err) {
          const messageSafe = safeError(err);
          const auth = err.status === 401 || err.status === 403;
          if (auth) { k.status = 'INVALID'; k.retryAt = 0; }
          else if (err.status === 402) { k.status = 'BILLING_REQUIRED'; k.retryAt = 0; }
          else if (err.status === 429) { k.status = 'COOLDOWN'; k.retryAt = Date.now() + 60_000; }
          else if (err.status === 404) { k.status = 'MODEL_UNAVAILABLE'; k.retryAt = 0; }
          else {
            // Keep discovered models on transient/network errors so the UI still shows them
            // and auto-retry / rotation can use this key after cooldown.
            k.status = 'ERROR';
            k.retryAt = Date.now() + 15_000;
          }
          k.lastError = messageSafe;
          k.lastChecked = new Date().toISOString();
          failures.push({ provider: k.provider, model: chosen, reason: messageSafe, status: err.status || null });
          await logger.write('provider.chat.failed', 'error', {
            requestId, provider: k.provider, model: chosen, keyId: k.id, error: messageSafe, status: err.status || null
          });
          await saveState();
        }
      }

      await logger.write('chat.failed', 'error', {
        requestId, reason: 'ALL_PROVIDERS_FAILED', provider, model,
        attempts: failures.length, failures
      });
      return {
        reply: '',
        error: 'ALL_PROVIDERS_FAILED',
        message: 'All eligible AI routes failed. Open Settings → Activity Log for the exact failure, then Test / refresh models.',
        failures,
        needsUserAction: true,
        requestId
      };
    },

    keys: {
      async listKeys(provider) {
        await loadState();
        return state.keys.filter(k => !provider || k.provider === provider).map(publicKey);
      },

      async addKey({ provider, token, model }) {
        await loadState();
        if (!providers[provider]) throw Object.assign(new Error('UNKNOWN_PROVIDER'), { statusCode: 400 });
        if (provider !== 'local' && !token?.trim()) throw Object.assign(new Error('TOKEN_REQUIRED'), { statusCode: 400 });

        // Detect mismatched token prefixes and warn via logs (still allow explicit provider).
        const hint = detectProviderHint(token);
        if (hint && hint !== provider && provider !== 'local') {
          await logger.write('token.provider_mismatch', 'warn', {
            requestedProvider: provider, suggestedProvider: hint, tokenPrefix: String(token).slice(0, 6)
          });
        }

        const id = crypto.randomUUID();
        const masked = provider === 'local' ? 'LOCAL' : `${token.slice(0, 4)}...${token.slice(-4)}`;
        const key = {
          id, provider, masked, status: 'TEST_REQUIRED', models: [],
          selectedModel: model || null, createdAt: new Date().toISOString(),
          lastChecked: null, lastError: null, retryAt: 0, useCount: 0
        };
        state.keys.push(key);
        await vault.set(id, token || '');
        await saveState();
        await logger.write('token.added', 'info', { provider, keyId: id });

        // Always verify server-side (including local) so keys do not stay TEST_REQUIRED forever.
        return await kernel.keys.verifyKey(id);
      },

      async verifyKey(id) {
        await loadState();
        const k = state.keys.find(x => x.id === id);
        if (!k) throw Object.assign(new Error('KEY_NOT_FOUND'), { statusCode: 404 });
        const p = providers[k.provider];
        if (!p) throw Object.assign(new Error('UNKNOWN_PROVIDER'), { statusCode: 400 });

        await logger.write('token.verify.start', 'info', { provider: k.provider, keyId: k.id });
        const previousModels = [...(k.models || [])];

        try {
          const token = k.provider === 'local' ? '' : await vault.get(k.id);
          if (k.provider !== 'local' && !token) throw new Error('TOKEN_NOT_FOUND');

          let models;
          if (k.provider === 'local') {
            // Multi-URL Ollama discovery (host.docker.internal, etc.) — not single baseUrl.
            const localInfo = await kernel.local.models();
            if (!localInfo.available) throw new Error(localInfo.error || 'LOCAL_UNAVAILABLE');
            models = localInfo.models || [];
          } else {
            models = await listModels(p, token, fetchImpl);
          }
          k.models = models.length ? models.filter(isChatCapableModel) : (p.models || []).filter(isChatCapableModel);
          k.status = k.provider === 'local' && !k.models.length ? 'ERROR' : 'ACTIVE';
          if (k.provider === 'local' && !k.models.length) k.lastError = 'NO_LOCAL_MODELS_PULLED';
          else k.lastError = null;
          k.lastChecked = new Date().toISOString();
          k.retryAt = 0;
          if (k.selectedModel && !k.models.includes(k.selectedModel)) k.selectedModel = k.models[0] || null;
          await saveState();
          await logger.write('token.verified', 'info', {
            provider: k.provider, keyId: k.id, modelCount: k.models.length
          });
          return publicKey(k);
        } catch (err) {
          const isAuth = err.status === 401 || err.status === 403;
          const isLocalDown = k.provider === 'local';
          k.status = isAuth ? 'INVALID'
            : err.status === 402 ? 'BILLING_REQUIRED'
            : err.status === 429 ? 'COOLDOWN'
            : isLocalDown ? 'ERROR'
            : 'ERROR';
          k.retryAt = k.status === 'COOLDOWN' ? Date.now() + 60_000 : (isLocalDown ? Date.now() + 30_000 : 0);
          k.lastChecked = new Date().toISOString();
          k.lastError = safeError(err);
          // Preserve previously discovered models on transient failure so UI still shows them.
          if (!isAuth && previousModels.length && !(k.models || []).length) k.models = previousModels;
          await saveState();
          await logger.write('token.verify.failed', 'error', {
            provider: k.provider, keyId: k.id, error: safeError(err), status: err.status || null
          });
          return publicKey(k);
        }
      },

      async removeKey(id) {
        await loadState();
        const removed = state.keys.find(x => x.id === id);
        state.keys = state.keys.filter(x => x.id !== id);
        await vault.remove(id);
        if (removed?.provider === 'local') {
          state.config = state.config || {};
          state.config.localKeyRemoved = true;
        }
        await saveState();
        await logger.write('token.removed', 'info', { keyId: id, provider: removed?.provider || null });
        return { success: true };
      },

      async providers() {
        return Object.values(providers).map(providerInfo);
      }
    },

    logs: logger,

    local: {
      async models(opts = {}) {
        await loadState();
        // Restore saved custom base URL once
        if (state.config?.ollamaBaseUrl) local.setBaseUrl(state.config.ollamaBaseUrl);
        const health = await local.models({ force: !!opts.force });
        if (health.available) {
          if (health.baseUrl && providers.local) providers.local.baseUrl = health.baseUrl;
          // Log only on fresh success, not every cached hit
          // Rate-limit success logs (health probes often) — at most 1 / 10 min
          if (!health.cached && Date.now() - (globalThis.__paiLocalOkLog || 0) > 600_000) {
            globalThis.__paiLocalOkLog = Date.now();
            await logger.write('local.models.ok', 'info', { count: (health.models || []).length, base: health.baseUrl });
          }
          const lk = state.keys.find(k => k.provider === 'local');
          if (lk) {
            lk.models = health.models || [];
            lk.status = (health.models || []).length ? 'ACTIVE' : 'ERROR';
            lk.lastChecked = new Date().toISOString();
            lk.lastError = (health.models || []).length ? null : 'NO_LOCAL_MODELS_PULLED';
            await saveState();
          }
          return {
            available: true,
            models: health.models || [],
            baseUrl: health.baseUrl || local.getBaseUrl(),
            candidates: health.candidates || local.candidateUrls?.() || [],
            configuredBaseUrl: state.config?.ollamaBaseUrl || null
          };
        }
        // Offline path — log at most when not from cache
        // Rate-limit logs: at most once per 5 minutes (Docker health hits /health often)
        if (!health.cached && Date.now() - lastLocalFailLog > 300_000) {
          lastLocalFailLog = Date.now();
          await logger.write('local.models.failed', 'warn', {
            error: health.error,
            code: health.code || null,
            retryAfterMs: health.retryAfterMs || null
          });
        }
        const lk = state.keys.find(k => k.provider === 'local');
        if (lk) {
          lk.status = 'ERROR';
          lk.lastError = health.error || 'LOCAL_UNAVAILABLE';
          lk.lastChecked = new Date().toISOString();
          await saveState();
        }
        return {
          available: false,
          models: [],
          error: health.error || 'LOCAL_UNAVAILABLE',
          candidates: health.candidates || local.candidateUrls?.() || [],
          cached: !!health.cached,
          retryAfterMs: health.retryAfterMs || null,
          configuredBaseUrl: state.config?.ollamaBaseUrl || null,
          hint: 'Install Ollama on the SoloHost host, ensure it listens on 0.0.0.0:11434, then set Base URL (e.g. http://host.docker.internal:11434) and press Save / Refresh.'
        };
      },
      async setBaseUrl(url) {
        await loadState();
        state.config = state.config || {};
        const cleaned = url ? String(url).trim().replace(/\/$/, '') : '';
        state.config.ollamaBaseUrl = cleaned || null;
        local.setBaseUrl(cleaned || null);
        if (cleaned && providers.local) providers.local.baseUrl = cleaned;
        await saveState();
        await logger.write('local.base_url.set', 'info', { base: cleaned || null });
        return kernel.local.models({ force: true });
      },
      async pull(name) {
        if (!name?.trim()) throw Object.assign(new Error('MODEL_NAME_REQUIRED'), { statusCode: 400 });
        await loadState();
        if (state.config?.ollamaBaseUrl) local.setBaseUrl(state.config.ollamaBaseUrl);
        await logger.write('local.model.pull.start', 'info', { model: name, base: local.baseUrl?.() });
        try {
          const r = await local.pull(name);
          await logger.write('local.model.pull.success', 'info', { model: name, base: local.baseUrl?.() });
          const refreshed = await kernel.local.models({ force: true });
          return {
            success: true,
            model: name,
            status: r?.status || 'success',
            models: refreshed.models,
            baseUrl: refreshed.baseUrl
          };
        } catch (err) {
          await logger.write('local.model.pull.failed', 'error', { model: name, error: safeError(err) });
          const e = new Error(safeError(err));
          e.statusCode = err.statusCode || 502;
          throw e;
        }
      }
    },

    memory: {
      async list(limit = 100) {
        await loadState();
        return state.memory.slice(-Math.min(limit, 200)).reverse();
      },
      async clear() {
        await loadState();
        state.memory = [];
        await saveState();
        await logger.write('memory.cleared', 'info', {});
        return { success: true };
      },
      /** Export cloud interaction pairs for local fine-tuning / continued learning offline. */
      async trainingExport(limit = 200) {
        await loadState();
        return {
          format: 'chat-pairs',
          count: Math.min((state.training || []).length, limit),
          pairs: (state.training || []).slice(-limit)
        };
      },
      async clearTraining() {
        await loadState();
        state.training = [];
        await saveState();
        await logger.write('training.cleared', 'info', {});
        return { success: true };
      }
    },

    gateway: {
      async listTokens() {
        await loadState();
        return (state.gatewayTokens || []).map(t => ({
          id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsed: t.lastUsed || null
        }));
      },
      async createToken({ name } = {}) {
        await loadState();
        const raw = 'pah_' + crypto.randomBytes(24).toString('base64url');
        const id = crypto.randomUUID();
        const entry = {
          id,
          name: String(name || 'SoloHost app').slice(0, 80),
          prefix: raw.slice(0, 10) + '…',
          hash: crypto.createHash('sha256').update(raw).digest('hex'),
          createdAt: new Date().toISOString(),
          lastUsed: null
        };
        state.gatewayTokens = state.gatewayTokens || [];
        state.gatewayTokens.push(entry);
        await saveState();
        await logger.write('gateway.token.created', 'info', { tokenId: id, name: entry.name });
        return { id, name: entry.name, token: raw, prefix: entry.prefix, createdAt: entry.createdAt };
      },
      async revokeToken(id) {
        await loadState();
        state.gatewayTokens = (state.gatewayTokens || []).filter(t => t.id !== id);
        await saveState();
        await logger.write('gateway.token.revoked', 'info', { tokenId: id });
        return { success: true };
      },
      async validate(raw) {
        if (!raw) return null;
        await loadState();
        const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
        const hit = (state.gatewayTokens || []).find(t => t.hash === hash);
        if (!hit) return null;
        hit.lastUsed = new Date().toISOString();
        await saveState();
        return { id: hit.id, name: hit.name };
      }
    },

    routing: {
      async get() {
        await loadState();
        return {
          mode: state.config?.routingMode || 'balanced',
          modes: ['local_only', 'prefer_local', 'balanced', 'cloud'],
          description: {
            local_only: 'Only managed Ollama',
            prefer_local: 'Ollama first, then cloud',
            balanced: 'Any ready provider (least used)',
            cloud: 'Cloud providers only'
          }
        };
      },
      async set(mode) {
        const allowed = ['local_only', 'prefer_local', 'balanced', 'cloud'];
        if (!allowed.includes(mode)) throw Object.assign(new Error('INVALID_ROUTING_MODE'), { statusCode: 400 });
        await loadState();
        state.config = state.config || {};
        state.config.routingMode = mode;
        await saveState();
        await logger.write('routing.mode.set', 'info', { mode });
        return this.get();
      }
    },

    async health() {
      await loadState();
      const keys = state.keys.map(publicKey);
      const byProvider = {};
      for (const k of keys) {
        const bucket = byProvider[k.provider] ||= {
          total: 0, active: 0, invalid: 0, error: 0, cooldown: 0, billing: 0, modelUnavailable: 0, testRequired: 0
        };
        bucket.total++;
        if (k.status === 'ACTIVE') bucket.active++;
        else if (k.status === 'INVALID') bucket.invalid++;
        else if (k.status === 'COOLDOWN') bucket.cooldown++;
        else if (k.status === 'BILLING_REQUIRED') bucket.billing++;
        else if (k.status === 'MODEL_UNAVAILABLE') bucket.modelUnavailable++;
        else if (k.status === 'TEST_REQUIRED') bucket.testRequired++;
        else bucket.error++;
      }
      const localInfo = await kernel.local.models();
      return {
        ok: true,
        activeKeys: keys.filter(k => k.status === 'ACTIVE').length,
        totalKeys: keys.length,
        providers: Object.values(providers).length,
        local: localInfo.available,
        localModels: localInfo.models?.length || 0,
        localStatus: localInfo.status || (localInfo.available ? 'ready' : 'unavailable'),
        localCode: localInfo.code || null,
        routingMode: state.config?.routingMode || 'balanced',
        byProvider
      };
    },

    async diagnostics() {
      const h = await kernel.health();
      return {
        ...h,
        executionPlane: 'Unified AI Kernel → Provider Adapter → Model',
        privacy: 'local memory + encrypted provider credentials + local training pairs',
        chat: 'secondary UI; Hub APIs are primary integration surface',
        gateway: { chat: '/api/v1/chat', keys: '/api/v1/keys', health: '/api/v1/health' }
      };
    }
  };

  return {
    ...kernel,
    mount(app, prefix = '/ai') {
      mountKernel(app, { prefix, kernel: this, manage: true });
    }
  };
}

function extractModelHint(message) {
  const text = String(message || '');
  // Gemini: "Please update your code to use models/gemini-3.1-pro-preview"
  const patterns = [
    /use models\/([A-Za-z0-9._:-]+)/i,
    /models\/([A-Za-z0-9._:-]+)/i,
    /model[:\s]+[`'"]?([A-Za-z0-9._:-]+)/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match && match[1] && !/generateContent|list/i.test(match[1])) return match[1];
  }
  return null;
}

function detectProviderHint(token) {
  const t = String(token || '');
  if (/^gsk_/i.test(t)) return 'groq';
  if (/^sk-or-/i.test(t)) return 'openrouter';
  if (/^AIza/i.test(t)) return 'gemini';
  if (/^sk-ant-/i.test(t)) return 'anthropic';
  if (/^xai-/i.test(t)) return null;
  // bare sk- is ambiguous (OpenAI / DeepSeek) — never auto-assign
  return null;
}

function safeError(err) {
  return String(err?.message || err || 'UNKNOWN_ERROR')
    .replace(/(?:sk-|key-|token-|Bearer\s+|AIza)[A-Za-z0-9._-]+/gi, '[REDACTED]')
    .slice(0, 500);
}

export { createActionRegistry } from './actions.js';
export { createJsonFileStore } from './store.js';
