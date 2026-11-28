import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdir } from 'node:fs/promises';
import { createAiKernel, createActionRegistry, createJsonFileStore } from './ai-app-kernel/src/index.js';
import { ensureOllama } from './start-ollama.js';
import { mountOpenAICompat } from './openai-compat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
/** DNS name other SoloHost containers should use (docker compose service name). */
const SERVICE_NAME = process.env.SERVICE_NAME || process.env.HOSTNAME || 'personal-ai-hub';
/**
 * Optional public URL advertised to other apps (e.g. http://192.168.1.10:18080).
 * When unset, discovery lists service-DNS and common host aliases.
 */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.AI_HUB_PUBLIC_URL || '').replace(/\/$/, '');

await mkdir(DATA_DIR, { recursive: true });

const app = express();
app.set('trust proxy', true);

// --- CORS: allow SoloHost apps on other containers/origins to call the gateway ---
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // SoloHost apps may call from another origin or from server-side (no Origin).
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Personal-AI-Key, X-SoloHost-App-ID, X-Request-Id'
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const schema = {
  name: 'personal-ai-hub',
  collections: [
    { name: 'notes', fields: ['id', 'title', 'content', 'createdAt'] },
    { name: 'settings', fields: ['key', 'value'] }
  ]
};

const store = createJsonFileStore(path.join(DATA_DIR, 'app.json'), {
  notes: [
    {
      id: '1',
      title: 'Welcome Note',
      content: 'Welcome to your Personal AI Hub — the shared AI server for SoloHost apps.',
      createdAt: new Date().toISOString()
    }
  ],
  settings: []
});

const actions = createActionRegistry()
  .register({
    name: 'create_note',
    description: 'Create a new note in the hub',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title of the note' },
        content: { type: 'string', description: 'The content of the note' }
      },
      required: ['title', 'content']
    },
    async run({ title, content }) {
      const note = {
        id: Math.random().toString(36).substring(2, 11),
        title,
        content,
        createdAt: new Date().toISOString()
      };
      await store.put('notes', note);
      return { success: true, note };
    }
  })
  .register({
    name: 'list_notes',
    description: 'List all notes stored in the hub',
    parameters: { type: 'object', properties: {} },
    async run() {
      const notes = await store.list('notes');
      return { notes };
    }
  });

const ai = createAiKernel({
  schema,
  store,
  actions,
  stateFile: path.join(DATA_DIR, 'ai-state.json'),
  vaultFile: path.join(DATA_DIR, 'ai-vault.json'),
  masterFile: path.join(DATA_DIR, '.ai-master-key'),
  logFile: path.join(DATA_DIR, 'activity-log.json'),
  stickyFile: path.join(DATA_DIR, 'ai-sticky.json'),
  healthFile: path.join(DATA_DIR, 'ai-health.json')
});

// Hub UI + internal control plane
ai.mount(app, '/ai');
// Shared AI API for every SoloHost app (same execution plane)
ai.mount(app, '/api/v1');

// OpenAI-compatible Universal Provider — MUST be before /v1 catch-all
mountOpenAICompat(app, { kernel: ai, serviceName: SERVICE_NAME });

function buildConnectionHints(req) {
  const host = req.get('host') || `${SERVICE_NAME}:${PORT}`;
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const requestBase = `${proto}://${host}`;
  const bases = [];
  if (PUBLIC_BASE_URL) bases.push(PUBLIC_BASE_URL);
  bases.push(`http://${SERVICE_NAME}:${PORT}`);
  bases.push(requestBase);
  // Host-gateway aliases useful when apps run in Docker and Hub is published on the host
  if (process.env.HOST_PORT) {
    bases.push(`http://host.docker.internal:${process.env.HOST_PORT}`);
    bases.push(`http://172.17.0.1:${process.env.HOST_PORT}`);
  }
  return [...new Set(bases.filter(Boolean))];
}

app.get('/health', async (_req, res) => {
  try {
    const h = await ai.health();
    // Hub is healthy even when Ollama is down — cloud providers still work
    res.json({
      status: 'healthy',
      service: SERVICE_NAME,
      role: 'personal-ai-hub',
      timestamp: new Date().toISOString(),
      hub: h,
      ollama: {
        available: !!h.local,
        models: h.localModels || 0
      }
    });
  } catch {
    res.json({ status: 'healthy', service: SERVICE_NAME, timestamp: new Date().toISOString() });
  }
});

/**
 * Discovery document for SoloHost apps (App Builder, etc.).
 * NEVER returns HTML — always JSON.
 */
app.get('/api/v1/gateway', (req, res) => {
  const hostPort = process.env.HOST_PORT || '18080';
  const dockerBase = `http://${SERVICE_NAME}:8080`;
  const hostBase = `http://172.17.0.1:${hostPort}`;
  const externalBase = PUBLIC_BASE_URL || null;
  const primary = PUBLIC_BASE_URL || dockerBase;
  res.json({
    service: SERVICE_NAME,
    role: 'solohost-ai-gateway',
    version: process.env.npm_package_version || '1.6.0',
    openaiCompatible: true,
    defaultModel: 'auto',
    connections: {
      docker: {
        baseUrl: dockerBase,
        openaiBaseUrl: `${dockerBase}/v1`,
        note: 'Use from other SoloHost containers on the same Docker network'
      },
      host: {
        baseUrl: hostBase,
        openaiBaseUrl: `${hostBase}/v1`,
        note: 'Docker bridge gateway — for containers that cannot resolve service DNS'
      },
      ...(externalBase ? {
        external: {
          baseUrl: externalBase,
          openaiBaseUrl: `${externalBase}/v1`,
          note: 'Advertised PUBLIC_BASE_URL (browser / WAN). Not a bind address.'
        }
      } : {})
    },
    recommended: {
      serverToServer: `${dockerBase}/v1`,
      browser: externalBase ? `${externalBase}/v1` : `${hostBase}/v1`,
      external: externalBase ? `${externalBase}/v1` : null,
      nativeChat: `${dockerBase}/api/v1/chat`
    },
    endpoints: {
      openaiModels: 'GET /v1/models',
      openaiChat: 'POST /v1/chat/completions',
      openaiHealth: 'GET /v1/health',
      nativeChat: 'POST /api/v1/chat',
      health: 'GET /api/v1/health',
      gateway: 'GET /api/v1/gateway',
      gatewayTokens: '/api/v1/gateway/tokens'
    },
    auth: {
      header: 'Authorization: Bearer pah_…  OR  X-Personal-AI-Key: pah_…',
      createToken: 'POST /api/v1/gateway/tokens'
    },
    example: {
      curl: `curl -s ${dockerBase}/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer pah_YOUR_TOKEN" -H "X-SoloHost-App-ID: app-builder" -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'`
    },
    notes: [
      'Provider API keys stay in the Hub vault; apps only use pah_ gateway tokens.',
      'Managed Ollama runs inside the Hub container — apps never call Ollama directly.',
      'model=auto uses Hub smart routing (routing mode + health + fallback).',
      'Do not use http://127.0.0.1 from another container.'
    ]
  });
});

// Explicit JSON probe — never HTML
app.get('/api/v1/chat', (_req, res) => {
  res.status(405).json({
    error: 'METHOD_NOT_ALLOWED',
    message: 'Use POST /api/v1/chat with JSON body { "message": "..." }',
    service: SERVICE_NAME
  });
});

// API routes must never fall through to the SPA HTML shell.
app.use(['/api', '/ai', '/v1'], (req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    path: req.path,
    method: req.method,
    service: SERVICE_NAME,
    hint: 'See GET /api/v1/gateway for available endpoints'
  });
});

// SPA UI only for non-API GETs
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Smart health: do NOT continuously probe Ollama or re-verify ACTIVE keys.
// Only re-check ERROR / TEST_REQUIRED / COOLDOWN cloud keys on a long interval.
// Local Ollama is probed on demand (UI Refresh / pull) with negative caching.
const HEALTH_INTERVAL_MS = Number(process.env.AI_HEALTH_INTERVAL_MS || 60 * 60 * 1000); // 1h default
const runHealthCheck = async () => {
  try {
    const all = await ai.keys.listKeys();
    for (const key of all) {
      if (key.provider === 'local') continue; // never auto-spam Ollama
      if (key.status === 'ACTIVE' || key.status === 'INVALID' || key.status === 'BILLING_REQUIRED') continue;
      if (key.status === 'ERROR' || key.status === 'TEST_REQUIRED' || key.status === 'COOLDOWN') {
        await ai.keys.verifyKey(key.id);
      }
    }
  } catch (err) {
    console.error('AI health refresh failed:', err.message);
  }
};
// First run after 60s (not 2s) to avoid startup storm
setTimeout(runHealthCheck, 60_000);
setInterval(runHealthCheck, HEALTH_INTERVAL_MS).unref();

// Managed Local AI: start Ollama in background — never block API listen
ensureOllama()
  .then((ollamaBoot) => console.log('[hub] Ollama boot status:', JSON.stringify(ollamaBoot)))
  .catch((err) => console.warn('[hub] ensureOllama failed:', err?.message || err));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Personal AI Hub listening on 0.0.0.0:${PORT}`);
  console.log(`Service DNS name: ${SERVICE_NAME}`);
  console.log(`Gateway discovery: http://${SERVICE_NAME}:${PORT}/api/v1/gateway`);
  if (PUBLIC_BASE_URL) console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log('Other SoloHost apps must call the Hub via service name or host port — never 127.0.0.1 from another container.');
});
