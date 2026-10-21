import { verifyAccessPassword, accessCookieHeader, accessPasswordConfigured } from '../http-access-auth.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { publicConfig } from '../config/index.js';
import { catalog, locales } from '../i18n/index.js';
import { scanProject } from '../security/scanner.js';
import { classifyAction } from '../security/policy.js';
import { importZipBuffer } from '../projects/importer.js';
import { listFiles } from '../utils/fsx.js';
import { maskKey } from '../utils/mask.js';
import { saveAttachment, attachmentList } from '../projects/attachments.js';
import { powerWarning } from '../docker/modes.js';
import { preflightPrompt } from '../ai/prompts.js';
import { normalizeDeepSeekModel } from '../ai/providers/deepseek.js';
import { inferAction, parseGithubRepoUrl } from '../scripts/ops.js';
import { routeIntent, isFastPath, isMultiStep } from '../router/intent.js';
import { detectUserLanguage } from '../ai/language.js';
import { createProjectZip } from '../projects/exporter.js';
import { gcDocker } from '../docker/cleanup.js';

export function registerRoutes(r, app) {
  const { cfg, db, jobs, projects, snapshots, github, releases, runner, ai } = app;

  const ensureFree = (projectId, res) => {
    if (!jobs.isBusy(projectId)) return true;
    const current = jobs.runningJob(projectId);
    res.status(202).json({
      busy: true,
      reused: true,
      jobId: current?.id || null,
      stage: current?.stage || 'running',
      message: 'An action is already running. I kept the current job and will follow its result instead of starting a duplicate action.'
    });
    return false;
  };

  r.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: cfg.version,
      ai: (cfg.ai.geminiKey || cfg.ai.deepseekKey) ? 'configured' : 'missing',
      github: github.configured() ? 'configured' : 'optional',
      engine: cfg.runtime?.podman?.apiUrl ? 'podman-sandbox' : 'native-preview',
      preview: { mode: cfg.runtime?.mode || 'auto', containerSandbox: Boolean(cfg.runtime?.podman?.apiUrl), dockerSocket: false },
    });

    r.get('/api/remote/info', async (req, res) => {
    try {
      const { resolvePublicUrl, isLoopbackRequest, rememberPublicPort } = await import('../remote/info.js');
      rememberPublicPort(req);
      const dataDir = cfg.dataDir || cfg.paths?.data || path.join(process.cwd(), 'data');
      const refresh = String(req.query?.refresh || '') === '1' || String(req.query?.refresh || '') === 'true';
      if (refresh) {
        try { await fs.unlink(path.join(dataDir, 'public-ip-cache.json')); } catch { /* none */ }
      }
      const resolved = await resolvePublicUrl({ cfg, req, dataDir });
      const passwordEnabled = Boolean(cfg.accessPassword);
      res.json({
        ok: true,
        publicUrl: resolved.publicUrl || '',
        source: resolved.source || 'none',
        publicIp: resolved.publicIp || '',
        hostPort: resolved.hostPort || 0,
        ipSource: resolved.ipSource || '',
        portSource: resolved.portSource || '',
        passwordEnabled,
        loopback: isLoopbackRequest(req),
      });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
  r.post('/api/remote/url', async (req, res) => {
    try {
      const url = String(req.body?.publicUrl || req.body?.url || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid URL' });
      const dataDir = cfg.dataDir || cfg.paths?.data || path.join(process.cwd(), 'data');
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, 'remote.json'), JSON.stringify({ publicUrl: url.replace(/\/$/, ''), updatedAt: new Date().toISOString() }, null, 2));
      res.json({ ok: true, publicUrl: url.replace(/\/$/, '') });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  });


  r.post('/api/access/generate', async (req, res) => {
    try {
      const { isLoopbackRequest } = await import('../remote/info.js');
      const authorized = isLoopbackRequest(req) || (req.headers.cookie || '').includes('builder_access=');
      if (!authorized && cfg.accessPassword) return res.status(403).json({ error: 'Forbidden' });
      if (cfg.accessPassword && !isLoopbackRequest(req)) return res.status(400).json({ error: 'Password already set' });
      const crypto = await import('node:crypto');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      let password = '';
      const bytes = crypto.randomBytes(12);
      for (let i = 0; i < 12; i++) password += alphabet[bytes[i] % alphabet.length];
      const dataDir = cfg.dataDir || cfg.paths?.data || path.join(process.cwd(), 'data');
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, 'access.json'), JSON.stringify({ password, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      cfg.accessPassword = password;
      const { tokenFor, accessCookieHeader } = await import('../http-access-auth.js').catch(() => ({}));
      const { verifyAccessPassword, accessCookieHeader: ach } = await import('../http-access-auth.js');
      const v = verifyAccessPassword(password, cfg);
      if (v.token) res.setHeader('Set-Cookie', ach(v.token));
      res.json({ ok: true, password, once: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
  r.get('/ready', (_req, res) => {
    res.json({ ready: true });
  });

  r.get('/api/status', (_req, res) => {
    const status = publicConfig(cfg);
    Object.assign(status.ai, ai.status());
    res.json(status);
  });

  r.get('/api/i18n', (req, res) => {
    const locale = String(req.query.locale || cfg.locale || 'en');
    res.json({ locale, locales, strings: catalog(locale) });
  });

  r.get('/api/settings', (_req, res) => {
    res.json({
      ...publicConfig(cfg),
      ai: { ...publicConfig(cfg).ai, geminiModel: ai.status().geminiModel },
      setupComplete: Boolean(db.setting('setupComplete', false)),
      powerWarning: powerWarning(),
      masked: {
        podman: cfg.runtime?.podman?.apiUrl ? '[configured]' : '',
        gemini: maskKey(cfg.ai.geminiKey),
        deepseek: maskKey(cfg.ai.deepseekKey),
        github: maskKey(cfg.github.token),
      },
    });
  });

  r.post('/api/settings', async (req, res) => {
    const body = req.body || {};
    const allowed = ['AI_PROVIDER', 'AI_MODE', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'APP_LOCALE', 'PODMAN_API_URL', 'SANDBOX_PODMAN_API_URL', 'CONTAINER_SANDBOX_PODMAN_API_URL', 'FEEDBACK_HUB_URL', 'FEEDBACK_APP_ID'];
    const applied = [];
    const stored = db.setting('runtimeSecrets', {}) || {};
    const oldGeminiKey = stored.GEMINI_API_KEY || cfg.ai.geminiKey || '';
    const oldProvider = String(cfg.ai.provider || 'deepseek').toLowerCase();
    const oldGeminiModel = String(cfg.ai.geminiModel || '');
    const oldDeepseekModel = String(cfg.ai.deepseekModel || '');
    for (const key of allowed) {
      // Empty secret fields mean "keep the existing value", not "erase it".
      // Non-secret Feedback Hub settings are allowed to be cleared explicitly.
      if ((key === 'FEEDBACK_HUB_URL' || key === 'FEEDBACK_APP_ID') && body[key] != null && String(body[key]).trim() === '') {
        delete process.env[key];
        delete stored[key];
        applied.push(key);
        continue;
      }
      if (body[key] != null && String(body[key]) !== '') {
        process.env[key] = String(body[key]);
        stored[key] = process.env[key];
        applied.push(key);
      }
    }
    if (body.setupComplete) db.setSetting('setupComplete', true);
    if ((stored.GEMINI_API_KEY && stored.GEMINI_API_KEY !== oldGeminiKey) || (body.GEMINI_MODEL != null && String(body.GEMINI_MODEL) !== oldGeminiModel) || (body.AI_PROVIDER != null && String(body.AI_PROVIDER).toLowerCase() !== oldProvider)) db.setSetting('geminiStickyModel', '');
    db.setSetting('runtimeSecrets', stored);
    const selectedProvider = String(process.env.AI_PROVIDER || cfg.ai.provider || 'deepseek').toLowerCase();
    cfg.ai.provider = ['gemini', 'deepseek'].includes(selectedProvider) ? selectedProvider : 'deepseek';
    cfg.ai.mode = (process.env.AI_MODE || cfg.ai.mode || 'single').toLowerCase() === 'council' ? 'council' : 'single';
    cfg.ai.geminiKey = process.env.GEMINI_API_KEY || cfg.ai.geminiKey;
    cfg.ai.geminiModel = process.env.GEMINI_MODEL || cfg.ai.geminiModel;
    cfg.ai.deepseekKey = process.env.DEEPSEEK_API_KEY || cfg.ai.deepseekKey;
    cfg.ai.deepseekModel = normalizeDeepSeekModel(process.env.DEEPSEEK_MODEL || cfg.ai.deepseekModel || 'deepseek-v4-flash');
    if (body.DEEPSEEK_MODEL != null) cfg.ai.deepseekModel = normalizeDeepSeekModel(body.DEEPSEEK_MODEL);
    cfg.github.token = process.env.GITHUB_TOKEN || cfg.github.token;
    cfg.github.owner = process.env.GITHUB_OWNER || cfg.github.owner;
    cfg.runtime.podman.apiUrl = process.env.PODMAN_API_URL || process.env.SANDBOX_PODMAN_API_URL || process.env.CONTAINER_SANDBOX_PODMAN_API_URL || cfg.runtime.podman.apiUrl || '';
    cfg.feedbackHub.url = String(process.env.FEEDBACK_HUB_URL || cfg.feedbackHub.url || '').replace(/\/$/, '');
    cfg.feedbackHub.appId = String(process.env.FEEDBACK_APP_ID || cfg.feedbackHub.appId || 'app-builder-pi-solohost');
    runner.configurePodman?.(cfg.runtime.podman.apiUrl);
    ai.refresh();

    let discovery = null;
    if (body.discoverGemini === true && cfg.ai.geminiKey) {
      try { discovery = await ai.discoverGemini(Boolean(body.forceGeminiDiscovery)); }
      catch (err) { discovery = { error: friendly(err) }; }
    }
    res.json({ ok: true, applied, discovery, status: { ...publicConfig(cfg), ai: { ...publicConfig(cfg).ai, geminiModel: ai.status().geminiModel } } });
  });


  // Legacy alias — never expose ingestToken to the browser
  r.get('/api/shfh-config', (_req, res) => {
    const hub = cfg.feedbackHub || {};
    const hubUrl = String(hub.url || process.env.SHFH_HUB_URL || '').replace(/\/$/, '');
    res.json({
      hubId: hub.hubId || process.env.SHFH_HUB_ID || '',
      hubUrl,
      formUrl: hubUrl ? hubUrl + '/feedback' : '',
      appId: hub.appId || 'app-builder-pi-solohost',
      appName: hub.appName || 'App Builder — Pi SoloHost',
      version: cfg.version,
      platform: 'solohost',
      enabled: hub.enabled !== false,
    });
  });

  // legacy /api/feedback/submit removed — use Universal Feedback POST /api/feedback

  r.get('/api/access/status', (_req, res) => {
    res.json({ passwordRequired: accessPasswordConfigured(cfg) });
  });

  r.post('/api/access/login', (req, res) => {
    const password = String(req.body?.password || '');
    const result = verifyAccessPassword(password, cfg);
    if (!result.ok) return res.status(401).json({ ok: false, error: 'Incorrect password.' });
    if (result.token) res.setHeader('Set-Cookie', accessCookieHeader(result.token));
    res.json({ ok: true });
  });

  r.post('/api/access/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'builder_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
  });

  r.get('/api/activity/global', async (req, res) => {
    const limit = Math.min(Number(req.query?.limit || 80), 200);
    const projectId = String(req.query?.projectId || '');
    try {
      if (projectId) {
        const project = projects.get(projectId);
        if (!project) return res.status(404).json({ error: 'Project not found.' });
        const activity = await projects.readMetadata(project, 'activity.json', []);
        const jobsList = jobs.list({ projectId, limit: 30 });
        return res.json({ activity: (Array.isArray(activity) ? activity : []).slice(-limit), jobs: jobsList });
      }
      const recent = jobs.list({ limit });
      return res.json({ activity: [], jobs: recent });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  r.get('/api/ai/hub', (_req, res) => {
    res.json(ai.hub.publicState());
  });


  // Robot panel chat — SAME AIGateway as main Builder (Gemini/DeepSeek/Hub).
  // Prefer this path so the panel never depends on a second Universal AI plane.

  // SoloHost field policy + validation
  r.get('/api/projects/:id/solohost/fields', async (req, res) => {
    try {
      const p = projects.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const { suggestPolicy, loadFieldPolicy, policyHash } = await import('../release/solohost-fields.js');
      const { inventoryFromSource } = await import('../release/solohost.js');
      const source = projects.sourceDir(p.slug);
      const path = await import('node:path');
      const inventory = await inventoryFromSource(source);
      const metaDir = path.join(projects.projectDir(p), 'metadata');
      const saved = await loadFieldPolicy(metaDir);
      const suggestions = {
        full: suggestPolicy(inventory, 'full'),
        defaults: suggestPolicy(inventory, 'defaults'),
        auth: suggestPolicy(inventory, 'auth'),
        custom: suggestPolicy(inventory, 'custom'),
      };
      res.json({
        inventory,
        inventoryHash: policyHash(inventory),
        policy: saved,
        suggestions,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || 'fields failed' });
    }
  });

  r.post('/api/projects/:id/solohost/fields', async (req, res) => {
    try {
      const p = projects.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const { saveFieldPolicy, policyHash } = await import('../release/solohost-fields.js');
      const path = await import('node:path');
      const metaDir = path.join(projects.projectDir(p), 'metadata');
      const { validatePolicyBody } = await import('../release/solohost-fields.js');
      const body = validatePolicyBody(req.body || {});
      const policy = {
        ...body,
        inventoryHash: req.body?.inventoryHash || null,
        updatedAt: new Date().toISOString(),
      };
      await saveFieldPolicy(metaDir, policy);
      res.json({ ok: true, policy });
    } catch (err) {
      res.status(500).json({ error: err.message || 'save policy failed' });
    }
  });

  r.post('/api/projects/:id/solohost/validate', async (req, res) => {
    try {
      const p = projects.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const source = projects.sourceDir(p.slug);
      const result = await releases.validateSoloHost(source, {
        acceptUnverified: req.body?.acceptUnverified === true,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message || 'validate failed' });
    }
  });

  r.post('/api/projects/:id/solohost/preview-env', async (req, res) => {
    try {
      const p = projects.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const source = projects.sourceDir(p.slug);
      const configOptionsYaml = await fs.readFile(path.join(source, 'solohost', 'config_options.yml'), 'utf8');
      const { previewEnv } = await import('../release/solohost-api.js');
      const data = await previewEnv({ configOptionsYaml, values: req.body?.values || {} });
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: err.message || 'preview-env failed' });
    }
  });

  r.post('/api/panel/chat', async (req, res) => {
    try {
      const message = String(req.body?.message || '').trim();
      if (!message) return res.status(400).json({ ok: false, error: 'message required' });
      const st = ai.status?.() || {};
      if (!st.configured) {
        const vi = /[àáạảãâăèéêìíòóôơùúưýăđ]|bạn|xin chào|làm gì/i.test(message);
        return res.json({
          ok: true,
          configured: false,
          source: 'local',
          provider: 'local',
          model: 'guide',
          reply: vi
            ? 'Chưa có AI. Mở ⚙ Settings → thêm Gemini (hoặc DeepSeek/Custom) → Save, rồi chat lại ở panel.'
            : 'No AI configured. Open ⚙ Settings → add Gemini (or DeepSeek/Custom) → Save, then try the panel again.',
        });
      }
      const hist = Array.isArray(req.body?.history) ? req.body.history.slice(-4) : [];
      const histText = hist
        .map((h) => `${h.role || 'user'}: ${String(h.content || '').slice(0, 400)}`)
        .filter(Boolean)
        .join('\n');
      const system = [
        'App Builder — Pi SoloHost robot panel. Reply in the user language. Be short and practical.',
        'Help with Build, Run, Improve, Publish, GitHub token, SoloHost install (2 files), Feedback.',
        'You are App Builder, not Personal AI Hub. Never invent Publish success.',
      ].join('\n');
      const prompt = histText ? `${histText}\nuser: ${message}` : message;
      const out = await Promise.race([
        ai.complete({ task: 'USER_CHAT', prompt, system, json: false }),
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('AI timed out after 55s'), { code: 'TIMEOUT' })), 55000)),
      ]);
      const reply = String(out?.text || out?.reply || out?.content || '').trim();
      if (!reply) return res.status(502).json({ ok: false, configured: true, error: 'Empty AI response', source: 'builder-hub' });
      return res.json({
        ok: true,
        reply,
        configured: true,
        source: 'builder-hub',
        provider: out.provider || st.primary || 'builder',
        model: out.model || 'auto',
        actions: [],
      });
    } catch (err) {
      const msg = String(err.message || err).slice(0, 240);
      return res.status(502).json({
        ok: false,
        configured: true,
        source: 'builder-hub',
        error: `AI unavailable: ${msg}`,
        reply: `AI unavailable: ${msg}`,
        code: err.code || 'AI_ERROR',
      });
    }
  });


  // Discover models using Provider + API key from Settings form (before or after Add).
  r.post('/api/ai/hub/discover', async (req, res) => {
    try {
      const body = req.body || {};
      const provider = String(body.provider || '').toLowerCase().trim();
      const apiKey = String(body.apiKey || '').trim();
      const baseUrl = String(body.baseUrl || '').trim();
      if (!provider) return res.status(400).json({ error: 'Choose an AI provider.' });
      // Prefer form key; else reuse stored connection key for that provider
      let key = apiKey;
      let url = baseUrl;
      if (!key) {
        const st = ai.hub.state();
        const row = (st.connections || []).find((c) => c.provider === provider) || (st.connections || [])[0];
        if (!row) return res.status(400).json({ error: 'Paste an API key first, or Add a provider, then Load models.' });
        key = ai.hub.key(row);
        url = url || row.baseUrl || '';
      }
      if (!key) return res.status(400).json({ error: 'Paste an API key for this provider.' });
      const probed = await ai.hub.testConnection({ provider, apiKey: key, baseUrl: url, model: body.model });
      const models = Array.isArray(probed?.models) ? probed.models : [];
      // If this provider already connected, merge models onto it for the dropdown
      const st = ai.hub.state();
      const existing = (st.connections || []).find((c) => c.provider === provider);
      if (existing && models.length) {
        const map = new Map((existing.models || []).map((m) => [m.id || m, typeof m === 'object' ? m : { id: m }]));
        for (const m of models) {
          const id = m.id || m;
          if (!id) continue;
          if (!map.has(id)) map.set(id, { id, verified: !!m.verified, displayName: m.displayName || id });
        }
        ai.hub.upsertConnection({
          id: existing.id,
          provider: existing.provider,
          baseUrl: existing.baseUrl,
          credentialRef: existing.credentialRef,
          status: existing.status || 'READY',
          models: [...map.values()].slice(0, 80),
          lastVerified: existing.lastVerified || null,
          lastError: null,
        });
      }
      res.json({
        ok: true,
        models,
        verifiedModel: probed?.verifiedModel || models[0]?.id || null,
        warning: probed?.warning || null,
        hub: ai.hub.publicState(),
      });
    } catch (err) {
      const cls = err.classify || { user: err.message };
      res.status(400).json({ error: cls.user || err.message, code: cls.code || 'DISCOVER_FAILED' });
    }
  });

  r.post('/api/ai/hub/connect', async (req, res) => {
    const body = req.body || {};
    const provider = String(body.provider || '').toLowerCase();
    const apiKey = String(body.apiKey || '').trim();
    const baseUrl = String(body.baseUrl || '').trim();
    if (!provider) return res.status(400).json({ error: 'Choose a provider.' });
    if (!apiKey) return res.status(400).json({ error: 'Paste an API key.' });
    try {
      const probed = await ai.hub.testConnection({ provider, apiKey, baseUrl, model: body.model });
      const models = Array.isArray(probed?.models) ? probed.models : [];
      const id = `${provider}-${Date.now().toString(36)}`;
      ai.hub.upsertConnection({
        id,
        provider,
        apiKey,
        baseUrl,
        status: models.length ? 'VERIFIED' : 'READY',
        models,
        lastVerified: new Date().toISOString(),
        lastError: null,
      });
      ai.refresh();
      const verifiedModel = models.find((m) => m && m.verified)?.id || models[0]?.id || probed?.verifiedModel || null;
      res.json({ ok: true, models, verifiedModel, hub: ai.hub.publicState() });
    } catch (err) {
      const cls = err.classify || { user: err.message };
      res.status(400).json({ error: cls.user || err.message, code: cls.code || 'UNKNOWN_PROVIDER_ERROR' });
    }
  });

  r.post('/api/ai/hub/refresh', async (req, res) => {
    const id = String(req.body?.id || '');
    const row = ai.hub.state().connections.find((c) => c.id === id);
    if (!row) return res.status(404).json({ error: 'Connection not found.' });
    try {
      const models = await ai.hub.discover(row, { force: true, allowFallback: false });
      const verified = (row.models || []).filter((m) => m.verified === true);
      const next = models.map((m) => ({ ...m, verified: verified.some((v) => (v.id || v) === m.id) }));
      ai.hub.upsertConnection({ id: row.id, provider: row.provider, baseUrl: row.baseUrl, credentialRef: row.credentialRef, status: row.status, models: next, lastVerified: row.lastVerified, lastError: null });
      res.json({ ok: true, models: next, hub: ai.hub.publicState() });
    } catch (err) {
      const cls = err.classify || { user: err.message, code: 'UNKNOWN_PROVIDER_ERROR' };
      res.status(400).json({ error: cls.user || err.message, code: cls.code });
    }
  });

  r.post('/api/ai/hub/remove', (req, res) => {
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'Missing connection id.' });
    ai.hub.removeConnection(id);
    ai.refresh();
    res.json({ ok: true, hub: ai.hub.publicState() });
  });


  // Import a user-supplied model id list into the preferred (or first) connection.
  r.post('/api/ai/hub/models/import', (req, res) => {
    try {
      const raw = req.body?.models;
      const list = Array.isArray(raw)
        ? raw
        : String(raw || '')
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      const ids = [...new Set(list.map((x) => String(x).replace(/^models\//, '').trim()).filter(Boolean))].slice(0, 80);
      if (!ids.length) return res.status(400).json({ error: 'No model ids found. Upload a JSON array or one model id per line.' });
      const hub = ai.hub.publicState();
      const preferred = String(req.body?.provider || hub.preferredProvider || req.body?.connectionId || '').trim();
      let conn = (hub.connections || []).find((c) => c.id === preferred || c.provider === preferred);
      if (!conn) conn = (hub.connections || [])[0];
      if (!conn) return res.status(400).json({ error: 'Add a provider token first, then upload a model list.' });
      const existing = new Map((conn.models || []).map((m) => [m.id || m, m]));
      for (const id of ids) {
        if (!existing.has(id)) existing.set(id, { id, verified: false, displayName: id });
      }
      const models = [...existing.values()].slice(0, 80);
      ai.hub.upsertConnection({
        id: conn.id,
        provider: conn.provider,
        baseUrl: conn.baseUrl,
        credentialRef: conn.credentialRef,
        status: conn.status || 'READY',
        models,
        lastVerified: conn.lastVerified || null,
        lastError: null,
      });
      const preferredModels = [`${conn.provider}:${ids[0]}`];
      ai.hub.setRouting({ preferredProvider: conn.provider, preferredModels });
      res.json({ ok: true, imported: ids.length, models, preferredModels, hub: ai.hub.publicState() });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not import model list.' });
    }
  });

  r.post('/api/ai/hub/routing', (req, res) => {
    ai.hub.setRouting({
      preferredProvider: req.body?.preferredProvider,
      preferredModel: req.body?.preferredModel,
      preferredModels: req.body?.preferredModels,
    });
    ai.refresh();
    res.json({ ok: true, hub: ai.hub.publicState(), applied: true });
  });

  r.get('/api/ai/gemini/discover', async (req, res) => {
    if (!cfg.ai.geminiKey) {
      return res.json({
        ok: false,
        reason: 'Paste a Gemini API key, then tap Detect again.',
        model: null,
      });
    }
    try {
      const force = String(req.query.force || '') === '1';
      const result = await ai.discoverGemini(force);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.json({
        ok: false,
        reason: friendlyDiscover(err),
        model: null,
      });
    }
  });

  r.get('/api/activity', (req, res) => {
    const list = jobs.list({ projectId: req.query.projectId, limit: 20 });
    const items = list.map((row) => {
      const full = jobs.get(row.id) || row;
      return {
        id: row.id,
        projectId: row.project_id,
        type: row.type,
        status: row.status,
        stage: row.stage,
        error: row.error,
        running: row.status === 'running' || row.status === 'queued',
        events: full.events || [],
        summary: summarizeJob(full),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
    res.json({ items, running: items.some((i) => i.running) });
  });

  r.get('/api/projects', (_req, res) => {
    res.json(projects.list().map(brief));
  });

  r.post('/api/projects/:id/remember', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const message = String(req.body?.message || '').trim();
    const role = ['user', 'assistant', 'system', 'ai'].includes(req.body?.role) ? req.body.role : 'system';
    if (!message) return res.json({ ok: true, skipped: true });
    const mapped = role === 'ai' ? 'assistant' : role;
    await projects.chat(p, message.slice(0, 4000), mapped);
    res.json({ ok: true });
  });

  r.get('/api/projects/:id', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const files = await projects.sourceFiles(p);
    const analysis = await projects.readMetadata(p, 'requirements.json', {});
    const plan = await projects.readMetadata(p, 'architecture.json', {});
    const tests = await projects.readMetadata(p, 'test-plan.json', {});
    const security = await projects.readMetadata(p, 'security.json', {});
    const runtime = await projects.readMetadata(p, 'runtime.json', {});
    const snaps = snapshots.list(p.id);
    const rels = releases.list(p.id);
    const chat = await projects.chatHistory(p);
    const attachments = await attachmentList(projects.projectDir(p));
    const workPlan = await projects.readMetadata(p, 'work-plan.json', null);
    const workHistory = await projects.workHistory(p);
    const handoff = await projects.readMetadata(p, 'handoff.json', {});
    const upgradeSession = await projects.readMetadata(p, 'upgrade-session.json', null);
    res.json({ ...brief(p), files, analysis, plan, tests, security, runtime, snapshots: snaps, releases: rels, chat, attachments, workPlan, workHistory, handoff, upgradeSession });
  });

  r.post('/api/chat', async (req, res) => {
    const message = String(req.body?.message || req.body?.idea || '').trim();
    if (!message) return res.status(400).json({ error: 'Tell me what you want to build or ask.' });
    if (!ensureFree(null, res)) return;
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const lang = detectUserLanguage(message);
    const decision = routeIntent({ message, files, hasProject: false });
    const githubRepo = parseGithubRepoUrl(message);

    // Allowed without an open project: CREATE, UPGRADE_IMPORT, IMPORT, ASK, SETTINGS
    if (githubRepo || decision.intent === 'UPGRADE_IMPORT') {
      const job = jobs.enqueue({ type: 'upgrade_github_import', payload: { url: githubRepo?.url || message } });
      setImmediate(() => jobs.kick(job));
      return res.status(202).json({ jobId: job.id, message: 'GitHub Upgrade Workshop started.', route: 'upgrade', intent: 'UPGRADE_IMPORT', reply_language: lang });
    }
    if (decision.intent === 'IMPORT' || files.some((f) => /\.zip$/i.test(f?.name || f?.originalname || ''))) {
      const job = jobs.enqueue({ type: 'import_app', payload: { source: 'chat' } });
      job._files = files;
      setImmediate(() => jobs.kick(job));
      return res.status(202).json({ jobId: job.id, message: 'Importing ZIP…', route: 'import', intent: 'IMPORT', reply_language: lang });
    }
    if (decision.intent === 'SETTINGS') {
      return res.json({
        reply: lang === 'Vietnamese' ? 'Mở ⚙ Settings để thêm khóa AI hoặc GitHub.' : 'Open ⚙ Settings to add an AI or GitHub key.',
        route: 'answer', intent: 'SETTINGS', reply_language: lang,
      });
    }
    if (decision.intent === 'ASK' || decision.source === 'infer' && decision.intent === 'ASK') {
      try {
        const routed = await ai.completeJson({
          task: 'USER_CHAT',
          system: 'Answer briefly in the user language. Return JSON {route,reply}. route is answer unless user clearly wants a new app built.',
          prompt: preflightPrompt(message),
          images: [],
        });
        return res.json({
          reply: String(routed.json?.reply || '').trim() || (lang === 'Vietnamese' ? 'Bạn muốn tạo app gì?' : 'What app should I build?'),
          route: 'answer', intent: 'ASK', reply_language: lang,
        });
      } catch (err) {
        return res.json({
          reply: lang === 'Vietnamese'
            ? `AI tạm không trả lời được. Mô tả app bạn muốn tạo, hoặc dán link GitHub.`
            : `AI is unavailable. Describe the app to build, or paste a GitHub link.`,
          route: 'answer', intent: 'ASK', reply_language: lang,
        });
      }
    }
    // No project yet: RUN/PUBLISH/EXPORT/MODIFY(partial)/REPAIR/UNDO → guide only
    const blocked = new Set(['RUN', 'PUBLISH', 'EXPORT', 'REPAIR', 'UNDO']);
    if (blocked.has(decision.intent) || (decision.intent === 'MODIFY' && !/(?:tạo\s*app|build\s+(?:an?\s+)?app|make\s+(?:an?\s+)?app)/iu.test(message))) {
      return res.json({
        reply: lang === 'Vietnamese'
          ? 'Chưa có app. Hãy mô tả ý tưởng hoặc dán link GitHub.'
          : 'No app yet. Describe an idea or paste a GitHub link.',
        route: 'answer', intent: decision.intent, reply_language: lang,
      });
    }
    // CREATE (or MODIFY that describes a full app)
    const job = jobs.enqueue({ type: 'create_app', payload: { idea: message, autoBuild: true, intent: 'CREATE', reply_language: lang } });
    job._files = files;
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Builder started.', route: 'build', intent: 'CREATE', reply_language: lang });
  });

  r.post('/api/projects', (req, res) => {
    const idea = String(req.body?.idea || '').trim();
    if (!idea) return res.status(400).json({ error: 'Describe your idea first.' });
    if (!ensureFree(null, res)) return;
    const job = jobs.enqueue({ type: 'create_app', payload: { idea, autoBuild: Boolean(req.body.autoBuild) } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Builder started.' });
  });

  r.post('/api/projects/sandbox-demo', (_req, res) => {
    const job = jobs.enqueue({ type: 'sandbox_demo', payload: { idea: 'Sandbox App Benchmark' } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Sandbox benchmark started.' });
  });

  r.get('/api/sandbox-status', async (_req, res) => {
    const latest = projects.list().find((p) => /sandbox|benchmark/i.test(`${p.slug} ${p.name} ${p.idea || ''}`));
    if (!latest) return res.json({ ok: false, tested: false });
    const probe = await projects.readMetadata(latest, 'sandbox-probe.json', {});
    res.json({ ok: probe.ok === true, tested: Boolean(probe.at), at: probe.at || null, previewPath: probe.previewPath || null });
  });

  r.post('/api/projects/demo', (_req, res) => {
    const idea = 'Hello AI App: a tiny welcome page with a health check, so a first-time user can see Idea → Plan → Code → Test → Release without GitHub.';
    const job = jobs.enqueue({ type: 'create_app', payload: { idea, autoBuild: true, demo: true } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Demo started.' });
  });

  r.post('/api/projects/import', async (req, res) => {
    try {
      const uploaded = req.body?.file;
      if (!uploaded?.buffer) return res.status(400).json({ error: 'Upload a ZIP file.' });
      const idea = String(req.body.idea || req.body.note || `Imported app: ${uploaded.originalname || 'upload.zip'}`);
      const upgradeMode = req.body.upgrade === true || req.body.upgrade === 'true' || req.body.mode === 'upgrade';
      const job = jobs.enqueue({
        type: 'import_app',
        payload: {
          idea,
          filename: uploaded.originalname || 'upload.zip',
          improve: !upgradeMode && (req.body.improve === 'true' || req.body.improve === true),
          upgrade: upgradeMode,
          skipRepair: upgradeMode,
          mode: upgradeMode ? 'upgrade' : 'build',
        },
      });
      job._zip = uploaded.buffer;
      setImmediate(() => jobs.kick(job));
      res.status(202).json({ jobId: job.id, message: 'Import started.' });
    } catch (err) {
      res.status(500).json({ error: friendly(err) });
    }
  });

  r.post('/api/projects/:id/import', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const uploaded = req.body?.file;
    if (!uploaded?.buffer) return res.status(400).json({ error: 'Upload a ZIP file.' });
    const job = jobs.enqueue({
      type: 'import_app',
      projectId: p.id,
      payload: {
        projectId: p.id,
        idea: p.idea,
        filename: uploaded.originalname || 'upload.zip',
        replace: true,
        upgrade: true,
        skipRepair: true,
        mode: 'upgrade',
      },
    });
    job._zip = uploaded.buffer;
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Update from ZIP started.' });
  });


  r.post('/api/projects/:id/sandbox-command', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const command = String(req.body?.command || '').trim();
    if (!command) return res.status(400).json({ error: 'Sandbox command is empty.' });
    const job = jobs.enqueue({ type: 'sandbox_command', projectId: p.id, payload: { projectId: p.id, command, image: req.body?.image || null } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Sandbox command started.' });
  });

  r.post('/api/projects/upgrade/github', (req, res) => {
    const parsed = parseGithubRepoUrl(req.body?.url);
    if (!parsed) return res.status(400).json({ error: 'Use a public GitHub repository URL.' });
    const url = parsed.url;
    if (!ensureFree(null, res)) return;
    const job = jobs.enqueue({ type: 'upgrade_github_import', payload: { url } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'GitHub Upgrade Workshop started.' });
  });

  r.post('/api/projects/:id/diagnose', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const job = jobs.enqueue({ type: 'project_diagnose', projectId: p.id, payload: { projectId: p.id } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Project diagnosis started.' });
  });


  r.get('/api/projects/:id/diagnosis', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    res.json({ diagnosis: await projects.readMetadata(p, 'project-diagnosis.json', null), history: await projects.readMetadata(p, 'diagnosis-history.json', []) });
  });

  r.post('/api/projects/:id/upgrade/inspect', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const job = jobs.enqueue({ type: 'upgrade_inspect', projectId: p.id, payload: { projectId: p.id } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Upgrade inspection started.' });
  });

  r.post('/api/projects/:id/upgrade/request', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const request = String(req.body?.request || '').trim();
    const ruleText = String(req.body?.ruleText || '').trim();
    if (!request && !ruleText) return res.status(400).json({ error: 'Tell me what you want to improve, or attach a Rule file.' });
    const job = jobs.enqueue({ type: 'upgrade_request', projectId: p.id, payload: { projectId: p.id, request: request || 'Apply the attached Rule to this existing app.', ruleText } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Upgrade diagnosis started.' });
  });

  r.post('/api/projects/:id/upgrade/apply', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const job = jobs.enqueue({ type: 'upgrade_apply', projectId: p.id, payload: { projectId: p.id, request: req.body?.request || '', plan: req.body?.plan || null, approved: true } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Upgrade execution started.' });
  });

  r.post('/api/projects/:id/upgrade/resume', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const session = null;
    const job = jobs.enqueue({ type: 'upgrade_resume', projectId: p.id, payload: { projectId: p.id } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Upgrade resume started from the saved session.' });
  });

  r.get('/api/projects/:id/upgrade', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    res.json({
      baseline: await projects.readMetadata(p, 'upgrade-baseline.json', null),
      knowledge: await projects.readMetadata(p, 'upgrade-knowledge.json', null),
      plan: await projects.readMetadata(p, 'upgrade-plan.json', null),
      history: await projects.readMetadata(p, 'upgrade-history.json', []),
      repairs: await projects.readMetadata(p, 'upgrade-repair-history.json', []),
      session: await projects.readMetadata(p, 'upgrade-session.json', null),
      ruleExecution: await projects.readMetadata(p, 'upgrade-rule-execution.json', null),
      diagnosis: await projects.readMetadata(p, 'project-diagnosis.json', null),
    });
  });

  r.post('/api/projects/:id/chat', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Write a message first.' });
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const lang = detectUserLanguage(message);
    const decision = routeIntent({ message, files, hasProject: true });
    const githubRepo = parseGithubRepoUrl(message);

    if (githubRepo || decision.intent === 'UPGRADE_IMPORT') {
      const job = jobs.enqueue({ type: 'upgrade_github_import', payload: { url: githubRepo?.url || message } });
      setImmediate(() => jobs.kick(job));
      return res.status(202).json({ jobId: job.id, message: 'GitHub Upgrade Workshop started.', route: 'upgrade', intent: 'UPGRADE_IMPORT', reply_language: lang });
    }
    if (decision.intent === 'UNDO') {
      const list = typeof snapshots?.list === 'function' ? snapshots.list(p.id) : [];
      if (!list?.length) {
        return res.json({
          reply: lang === 'Vietnamese' ? 'Chưa có điểm khôi phục để hoàn tác.' : 'No checkpoint to undo.',
          route: 'answer', intent: 'UNDO', reply_language: lang,
        });
      }
      // Same path as POST /api/projects/:id/rollback
      const target = list[0];
      await snapshots.restore(p, target.id);
      return res.json({
        ok: true,
        reply: lang === 'Vietnamese' ? `Đã hoàn tác về điểm ${target.id}.` : `Rolled back to checkpoint ${target.id}.`,
        route: 'rollback', intent: 'UNDO', reply_language: lang, snapshotId: target.id,
      });
    }

    // Fast path only for short, high-confidence RUN / EXPORT (zip)
    const fast = isFastPath(decision, message);
    if (fast && decision.intent === 'RUN') {
      const job = jobs.enqueue({ type: 'run', projectId: p.id, payload: { projectId: p.id } });
      setImmediate(() => jobs.kick(job));
      return res.status(202).json({ jobId: job.id, message: 'Starting preview…', route: 'run', intent: 'RUN', reply_language: lang });
    }
    if (fast && decision.intent === 'EXPORT') {
      const job = jobs.enqueue({ type: 'export_zip', projectId: p.id, payload: { projectId: p.id, kind: 'project' } });
      setImmediate(() => jobs.kick(job));
      return res.status(202).json({ jobId: job.id, message: 'Preparing ZIP…', route: 'export', intent: 'EXPORT', reply_language: lang });
    }

    // PUBLISH, multi-step, MODIFY, REPAIR, low confidence → builder_chat (AI + gates)
    if (decision.intent === 'MODIFY' || decision.intent === 'REPAIR') {
      const job = jobs.enqueue({
        type: 'improve',
        projectId: p.id,
        payload: {
          projectId: p.id,
          feedback: message,
          intent: decision.intent,
          risk: decision.risk,
          reply_language: lang,
        },
      });
      job._files = files;
      setImmediate(() => jobs.kick(job));
      return res.status(202).json({ jobId: job.id, message: 'Applying change…', route: 'improve', intent: decision.intent, reply_language: lang });
    }

    if (String(p.status || '').startsWith('UPGRADE') && decision.intent !== 'ASK' && decision.intent !== 'PUBLISH') {
      const job = jobs.enqueue({ type: 'upgrade_request', projectId: p.id, payload: { projectId: p.id, request: message } });
      setImmediate(() => jobs.kick(job));
      return res.status(202).json({ jobId: job.id, message: 'Upgrade diagnosis started.', route: 'upgrade', intent: decision.intent, reply_language: lang });
    }

    // Default: builder_chat handles PUBLISH confirmation, multi-step, questions, etc.
    const job = jobs.enqueue({
      type: 'builder_chat',
      projectId: p.id,
      payload: {
        projectId: p.id,
        message,
        intent: decision.intent,
        risk: decision.risk,
        reply_language: lang,
        multiStep: decision.multiStep || isMultiStep(message),
      },
    });
    job._files = files;
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Builder is working.', intent: decision.intent, reply_language: lang, via: 'builder_chat' });
  });

  r.post('/api/projects/:id/attachments', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const files = req.body?.files || (req.body?.file ? [req.body.file] : []);
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Attach a file first.' });
    const saved = [];
    for (const file of files.slice(0, 8)) {
      if (!file?.buffer) continue;
      if (file.buffer.length > 64 * 1024 * 1024) throw new Error('Each attachment must be 64 MB or smaller.');
      saved.push(await saveAttachment(projects.projectDir(p), file));
    }
    await projects.chat(p, `📎 Attached ${saved.length} file(s).`, 'system', { attachments: saved.map((x) => ({ name: x.name, bytes: x.bytes, kind: x.kind })) });
    res.json({ ok: true, attachments: saved.map((x) => ({ name: x.name, bytes: x.bytes, kind: x.kind })) });
  });

  r.get('/api/docker/containers', async (req, res) => {
    res.json(await runner.listContainers({ all: String(req.query.all || '') === '1' }));
  });

  r.post('/api/docker/gc', async (req, res) => {
    const p = req.body?.projectId ? projects.get(req.body.projectId) : null;
    const keepImage = p ? `paf-app:${p.slug}` : null;
    const keepContainer = p ? `paf-app-${p.slug}` : null;
    const removed = await gcDocker({ keepImage, keepContainer: req.body?.keepLive ? keepContainer : null, log: app.log });
    res.json({ ok: true, removed });
  });

  r.get('/api/docker/containers/:id', async (req, res) => {
    res.json(await runner.inspectContainer(req.params.id));
  });

  r.post('/api/docker/containers/:id/analyze', async (req, res) => {
    if (!ensureFree(null, res)) return;
    const info = await runner.inspectContainer(req.params.id);
    if (info.status !== 'passed') return res.status(400).json(info);
    const image = await runner.imageInfo(info.image);
    const history = await runner.imageHistory(info.image);
    const logs = await runner.logs(info.name || req.params.id);
    const findings = [];
    if (info.mounts?.some((m) => m.type === 'bind')) findings.push({ severity: 'warning', title: 'Host bind mount', detail: 'This container can access a host path.' });
    if (info.mounts?.some((m) => m.destination === '/var/run/docker.sock')) findings.push({ severity: 'critical', title: 'Docker socket', detail: 'This container has host Docker control.' });
    if (info.state !== 'running') findings.push({ severity: 'warning', title: 'Container not running', detail: `Current state: ${info.state}` });
    if (info.health === 'unhealthy') findings.push({ severity: 'critical', title: 'Readiness failure', detail: 'Docker reports the app as unhealthy.' });
    res.json({ status: findings.some((f) => f.severity === 'critical') ? 'WARNING' : 'PASS', container: info, image, history, logs, findings });
  });

  r.post('/api/docker/containers/:id/import', async (req, res) => {
    if (!ensureFree(null, res)) return;
    const info = await runner.inspectContainer(req.params.id);
    if (info.status !== 'passed') return res.status(400).json(info);
    const analysis = { name: info.name || info.image || 'Imported Docker App', slug: String(info.name || info.image || 'imported-app').replace(/[^a-z0-9-]/gi, '-').toLowerCase(), summary: `Imported running Docker app ${info.image}`, core_features: ['Imported container'], optional_features: [], recommended_stack: { docker: true, image: info.image }, risks: [], questions: [], estimated_complexity: 'medium', source: 'docker-container' };
    const plan = { name: analysis.name, summary: analysis.summary, architecture: { style: 'imported-container', components: ['docker-image'] }, features: [], testing_strategy: ['Container health', 'Security scan'], deployment_strategy: ['SoloHost Docker image'], decisions: [] };
    const project = await projects.create({ idea: `Imported running container: ${info.name || info.image}`, name: analysis.name, analysis, plan });
    const result = await runner.exportContainer(req.params.id, projects.sourceDir(project.slug));
    if (result.status !== 'passed') return res.status(400).json(result);
    await projects.saveMetadata(project, 'container-import.json', { container: info, image: await runner.imageInfo(info.image), importedAt: new Date().toISOString() });
    projects.setStatus(project, 'READY_TO_BUILD');
    res.json({ ok: true, projectId: project.id, result });
  });

  for (const action of ['build', 'test', 'run', 'stop', 'security', 'analyze', 'sandbox', 'github', 'release']) {
    r.post(`/api/projects/:id/${action}`, (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (!ensureFree(p.id, res)) return;
      const perm = classifyAction(action === 'github' ? 'push_github' : action === 'release' ? 'publish_release' : action === 'run' ? 'run_tests' : 'run_tests');
      const confirmed = req.body?.confirm === true || req.body?.approved === true;
      if (['github', 'release', 'sandbox'].includes(action) && !confirmed && perm === 'CONFIRM') {
        return res.status(202).json({ needsConfirmation: true, action, permission: perm });
      }
      const job = jobs.enqueue({ type: action, projectId: p.id, payload: { projectId: p.id, ...req.body } });
      setImmediate(() => jobs.kick(job));
      res.status(202).json({ jobId: job.id, message: 'Job started.' });
    });
  }

  r.post('/api/projects/:id/answer', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const answers = req.body?.answers;
    if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'Choose an answer first.' });
    const job = jobs.enqueue({ type: 'continue_build', projectId: p.id, payload: { projectId: p.id, answers } });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Build resumed.' });
  });

  r.post('/api/projects/:id/improve', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (!ensureFree(p.id, res)) return;
    const feedback = String(req.body?.feedback || '').trim();
    if (!feedback) return res.status(400).json({ error: 'Tell AI what to improve.' });
    const job = jobs.enqueue({ type: 'improve', projectId: p.id, payload: { projectId: p.id, feedback } });
    job._files = Array.isArray(req.body?.files) ? req.body.files : [];
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'AI improvement started.', attachments: job._files.length });
  });

  r.post('/api/projects/:id/ask', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const job = jobs.enqueue({
      type: 'ask',
      projectId: p.id,
      payload: { projectId: p.id, question: req.body?.question },
    });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Job started.' });
  });

  r.post('/api/projects/:id/fix', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const job = jobs.enqueue({
      type: 'apply_patch',
      projectId: p.id,
      payload: { projectId: p.id, files: req.body?.files || [] },
    });
    setImmediate(() => jobs.kick(job));
    res.status(202).json({ jobId: job.id, message: 'Job started.' });
  });

  r.get('/api/projects/:id/file', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const rel = String(req.query.path || '');
    const files = await listFiles(projects.sourceDir(p.slug));
    if (!files.includes(rel)) return res.status(404).json({ error: 'File not found' });
    const text = await fs.readFile(path.join(projects.sourceDir(p.slug), rel), 'utf8').catch(() => '');
    res.json({ path: rel, content: text });
  });

  r.get('/api/projects/:id/export', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const files = await listFiles(projects.sourceDir(p.slug));
    const bundle = [];
    for (const rel of files) {
      const content = await fs.readFile(path.join(projects.sourceDir(p.slug), rel), 'utf8').catch(() => null);
      if (content != null) bundle.push({ path: rel, content });
    }
    res.json({ name: p.slug, files: bundle });
  });

  r.get('/api/projects/:id/download', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    let kind = String(req.query.kind || 'project');
    if (!['project', 'solohost'].includes(kind)) kind = 'project';
    const sourceDir = projects.sourceDir(p.slug);
    if (kind === 'solohost') {
      try { await fs.access(path.join(sourceDir, 'solohost', 'docker-compose.yml')); }
      catch { kind = 'project'; }
    }
    const artifact = await createProjectZip({ sourceDir, outputDir: path.join(projects.projectDir(p), 'artifacts'), slug: p.slug, kind, cfg });
    const data = await fs.readFile(artifact.path);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${artifact.filename}"`,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });

  async function resolveFallbackScript(preferredNames = []) {
    const roots = [
      path.resolve(process.cwd(), 'fallback'),
      path.resolve(process.cwd(), 'app', 'fallback'),
      path.resolve('/app/fallback'),
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../fallback'),
    ];
    for (const root of roots) {
      for (const name of preferredNames) {
        const candidate = path.join(root, name);
        try { await fs.access(candidate); return { path: candidate, filename: name }; } catch {}
      }
    }
    return null;
  }

  async function sendFallbackScript(res, names, missing) {
    const hit = await resolveFallbackScript(names);
    if (!hit) return res.status(404).json({ error: missing });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${hit.filename}"`);
    createReadStream(hit.path).pipe(res);
  }

  r.get('/api/projects/:id/github-fallback', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    await sendFallbackScript(res, ['GitHub-ZIP-Image-Publisher-v5.0.ps1'], 'GitHub fallback script is not installed.');
  });

  r.get('/api/scripts/github-publisher', async (_req, res) => {
    await sendFallbackScript(res, ['GitHub-ZIP-Image-Publisher-v5.0.ps1'], 'GitHub fallback script is not installed.');
  });

  r.get('/api/scripts/run-docker-app', async (_req, res) => {
    await sendFallbackScript(res, ['run-docker-app.ps1'], 'Run-from-ZIP script is not installed.');
  });

  r.get('/api/projects/:id/image', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const runtime = await projects.readMetadata(p, 'runtime.json', {});
    if (runtime.imageFile?.status !== 'passed' || !runtime.imageFile?.path) return res.status(404).json({ error: 'No tested image file is available yet. Run the app first.' });
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(runtime.imageFile.path)}"`);
    createReadStream(runtime.imageFile.path).pipe(res);
  });

  r.post('/api/projects/:id/rollback', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const snapId = req.body?.snapshotId;
    const list = snapshots.list(p.id);
    const target = snapId ? list.find((s) => s.id === snapId) : list[0];
    if (!target) return res.status(400).json({ error: 'No snapshot available yet.' });
    await snapshots.restore(p, target.id);
    projects.setStatus(p, 'ROLLED_BACK');
    res.json({ ok: true, snapshot: target });
  });

  r.post('/api/projects/:id/delete', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (req.body?.confirm !== true) {
      return res.json({ needsConfirmation: true, action: 'delete_project' });
    }
    await projects.archive(p);
    res.json({ ok: true });
  });

  // Reconcile a stale client-side job id after refresh/reconnect. The UI can
  // safely ask for the project's current owner without creating a new action.
  r.get('/api/jobs/current', (req, res) => {
    const projectId = String(req.query.projectId || '').trim() || null;
    const current = jobs.runningJob(projectId) || jobs.latestJob(projectId);
    res.json({
      active: Boolean(current && ['queued', 'running'].includes(current.status)),
      recovered: Boolean(current),
      jobId: current?.id || null,
      projectId: current?.project_id || projectId,
      type: current?.type || null,
      stage: current?.stage || null,
      status: current?.status || null,
    });
  });

  r.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(sanitizeJob(job));
  });

  // Lets the UI stop waiting on a running job (send-button-turned-stop-button).
  // The underlying work may finish in the background, but the chat/composer is freed
  // immediately so the user isn't stuck if a step is taking too long.
  r.post('/api/jobs/:id/cancel', (req, res) => {
    const job = jobs.requestCancel(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(sanitizeJob(job));
  });

  r.get('/api/jobs', (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query?.limit || 30), 200));
    res.json(jobs.list({ projectId: req.query.projectId, limit }));
  });

  // Read-only unified diagnostic feed: task lifecycle, every recorded job stage, and failures.
  r.get('/api/activity/unified', (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query?.limit || 80), 200));
    try {
      const summaries = jobs.list({ projectId: req.query.projectId, limit });
      const entries = [];
      for (const summary of summaries) {
        const job = jobs.get(summary.id);
        if (!job) continue;
        // Timeline only from real job events (avoid status summary colliding at created_at)
        const seenErr = new Set();
        for (const event of (job.events || [])) {
          const msg = `${job.type || 'task'} · ${event.stage || ''} · ${event.status || ''} · ${String(event.message || '').slice(0, 1200)}`;
          const isErr = /fail|error|blocked/i.test(`${event.status || ''} ${event.message || ''}`);
          if (isErr) {
            const key = String(event.message || msg).slice(0, 200);
            if (seenErr.has(key)) continue;
            seenErr.add(key);
          }
          entries.push({ ts: event.created_at || '', level: isErr ? 'error' : 'task', msg });
        }
        if (job.error) {
          const key = String(job.error).slice(0, 200);
          if (!seenErr.has(key)) {
            seenErr.add(key);
            entries.push({ ts: job.updated_at || '', level: 'error', msg: `${job.type || 'task'} failed: ${String(job.error).slice(0, 1200)}` });
          }
        }
      }
      entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      res.json({ entries: entries.slice(-500) });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  r.get('/api/projects/:id/logs', (req, res) => {
    res.json(jobs.list({ projectId: req.params.id, limit: 50 }));
  });

  r.post('/api/security/scan/:id', async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    res.json(await scanProject(projects.sourceDir(p.slug)));
  });

  r.get('/api/docker', (_req, res) => {
    const status = runner.status();
    res.json({
      ...status,
      warning: powerWarning(),
      safeByDefault: true,
      socketMountedByDefault: false,
    });
  });

}

function brief(p) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    idea: p.idea,
    status: p.status,
    version: p.version,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    stack: p.stack,
  };
}

function sanitizeJob(job) {
  return {
    id: job.id,
    projectId: job.project_id,
    type: job.type,
    status: job.status,
    stage: job.stage,
    result: job.result,
    error: job.error,
    events: job.events,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

function friendly(err) {
  return String(err.message || err);
}

function friendlyDiscover(err) {
  const m = String(err.message || err);
  if (/not configured/i.test(m)) return 'Paste a Gemini API key first.';
  if (/HTTP 400|HTTP 403|HTTP 401/.test(m)) return 'This Gemini key was rejected. Create a new key in Google AI Studio.';
  if (/HTTP 404/.test(m)) return 'Gemini could not list models for this key.';
  if (/fetch|network|ENOTFOUND|ECONN/.test(m)) return 'No network path to Google from this SoloHost.';
  return m.slice(0, 180);
}

function summarizeJob(job) {
  const events = job.events || [];
  const done = events.filter((e) => e.status === 'done' || e.status === 'running').map((e) => e.stage).filter(Boolean);
  const last = events[events.length - 1];
  const lines = [];
  if (job.status === 'running' || job.status === 'queued') lines.push(`Running: ${job.stage || job.type}`);
  else if (job.status === 'failed') lines.push(`Stopped: ${job.type} did not finish.`);
  else lines.push(`Stopped: ${job.type} finished.`);
  if (done.length) lines.push(`Done: ${[...new Set(done)].join(' → ')}`);
  if (job.error) lines.push(`Why not: ${job.error}`);
  else if (last?.message) lines.push(`Result: ${last.message}`);
  return lines.join(' ');
}
