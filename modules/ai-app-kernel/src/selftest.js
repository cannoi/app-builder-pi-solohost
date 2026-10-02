import { createAiKernel, createActionRegistry, createMemoryStore, listProviders } from './index.js';
import { collectAvailableKeys, detectProviderFromToken, pickProvider, modelsFor, createStickyRouter, keyBelongsToProvider } from './router.js';
import { existsSync } from 'node:fs';
import { logoPath } from './brand.js';
import { aiButtonHtml } from './http.js';

const checks = [];
delete process.env.AI_PROVIDER;
delete process.env.AI_MODEL;
delete process.env.AI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MISTRAL_API_KEY;
delete process.env.OLLAMA_BASE_URL;
delete process.env.LMSTUDIO_BASE_URL;
delete process.env.LOCAL_AI_BASE_URL;
delete process.env.AI_BASE_URL;
function ok(name, cond, extra = '') {
  checks.push({ name, pass: Boolean(cond), extra });
  if (!cond) console.error('FAIL', name, extra);
  else console.log('OK  ', name, extra);
}

ok('logo file', existsSync(logoPath), logoPath);
ok('button html has logo', aiButtonHtml().includes('/ai/logo.png'));
ok('providers include local', listProviders().some((p) => p.id === 'ollama') && listProviders().some((p) => p.id === 'local'));
ok('token groq', detectProviderFromToken('gsk_abc') === 'groq');
ok('token openrouter', detectProviderFromToken('sk-or-v1-x') === 'openrouter');
ok('token xai', detectProviderFromToken('xai-123') === 'xai');
ok('token gemini', detectProviderFromToken('AIzaSyX') === 'gemini');
ok('token openai', detectProviderFromToken('sk-proj-1') === 'openai');
ok('priority xai over openai', pickProvider({ keys: { openai: 'a', xai: 'b' } }) === 'xai');
ok('models exist', modelsFor('openai').length > 0);

const tokenRoute = createAiKernel({ apiKey: 'gsk_auto_route_test', stickyFile: '/tmp/ai-selftest-token-route.json' });
const tokenResolved = await tokenRoute.route();
ok('api key auto-detects provider', tokenResolved.provider === 'groq');
ok('api key auto-selects model', Boolean(tokenResolved.model) && tokenResolved.model !== '');

const localKernel = createAiKernel({ local: true, stickyFile: '/tmp/ai-selftest-local-route.json' });
const localResolved = await localKernel.route();
ok('local route without token', ['ollama', 'lmstudio', 'local'].includes(localResolved.provider));
ok('local route selects model', Boolean(localResolved.model));

const store = createMemoryStore({ notes: [] });
const actions = createActionRegistry().register({
  name: 'ping',
  description: 'ping',
  async run() { return { pong: true }; },
});
const ai = createAiKernel({ schema: { name: 't', collections: [{ name: 'notes', fields: ['id', 'text'] }] }, store, actions });
ok('kernel exports', typeof ai.chat === 'function' && typeof ai.mount === 'function');
ok('invoke action', (await ai.invoke('ping')).pong === true);
ok('schema collections', (await store.listCollections()).includes('notes'));
const schemaResult = await (await import('./tools.js')).runTool('app_schema', {}, { store, schema: { name: 't', collections: [{ name: 'notes', fields: ['id', 'text', 'apiKey'] }, { name: 'secrets', fields: ['id'] }] }, actions });
ok('schema hides sensitive collections and fields', schemaResult.collections.join(',') === 'notes' && !schemaResult.schema.collections[0].fields.includes('apiKey'));

const mounted = { routes: {} };
['get', 'post'].forEach((m) => {
  mounted[m] = (path, fn) => { mounted.routes[`${m} ${path}`] = fn; };
});
ai.mount(mounted, '/ai', { authorize: async () => true });
ok('mount has /ai/act', Boolean(mounted.routes['post /ai/act']));
ok('mount has /ai/health', Boolean(mounted.routes['get /ai/health']));
let actOut = null;
await mounted.routes['post /ai/act'](
  { body: { name: 'ping', args: {} } },
  { json: (x) => { actOut = x; return x; }, status() { return this; } },
);
ok('mounted /ai/act invokes', actOut && actOut.pong === true);
const failClosed = { routes: {} };
['get', 'post'].forEach((m) => { failClosed[m] = (path, fn) => { failClosed.routes[`${m} ${path}`] = fn; }; });
ai.mount(failClosed, '/ai');
let authStatus = 0;
await failClosed.routes['post /ai/act']({ body: { name: 'ping' } }, {
  json() {},
  status(code) { authStatus = code; return this; },
});
ok('protected routes fail closed without auth callback', authStatus === 503);

const router = createStickyRouter({ stickyFile: '/tmp/ai-sticky-test.json' });
await router.rememberSuccess('deepseek', 'deepseek-chat');
const snap = await router.snapshot();
ok('sticky remember', snap.provider === 'deepseek' && snap.model === 'deepseek-chat');

ok('openai key not for deepseek', keyBelongsToProvider('sk-proj-openai-secret', 'deepseek') === false);
ok('openai key for openai', keyBelongsToProvider('sk-proj-openai-secret', 'openai') === true);
ok('groq key not for openai', keyBelongsToProvider('gsk_abc', 'openai') === false);

const seenUrls = [];
const seenAuth = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  seenUrls.push(String(url));
  seenAuth.push(String((opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || ''));
  return {
    ok: false,
    status: 401,
    text: async () => 'invalid_api_key',
    json: async () => ({ error: 'invalid_api_key' }),
  };
};
try {
  const isolated = createAiKernel({
    apiKey: 'sk-proj-openai-only-secret',
    stickyFile: '/tmp/ai-selftest-key-isolation.json',
  });
  await isolated.chat({ message: 'hi' }).catch(() => {});
} finally {
  globalThis.fetch = realFetch;
}
ok('openai key never posted to deepseek', !seenUrls.some((u) => /deepseek/i.test(u)));
ok('openai key never posted to groq', !seenUrls.some((u) => /groq/i.test(u)));
ok('openai key only used on openai host', seenAuth.every((h) => !h || h.includes('sk-proj-openai-only-secret')) && seenUrls.every((u) => /openai\.com/i.test(u) || /generativelanguage/i.test(u) === false));

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
