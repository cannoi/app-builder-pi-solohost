import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLenient, closeTruncatedJson, parseNeedFiles, salvageFileBlocks, normalizeShape } from '../src/ai/response-doctor.js';
import { call, callJson, classifyError, interpretJsonAnswer, resetBreakers } from '../src/ai/client.js';
import { AIProviderHub, fallbackLadder } from '../src/ai/hub/hub.js';

const CODE = "const a = 'x'; // note: http://x.y\nif (a) { b: 1 }\n/* c */ let u = \"q\";\n";
const GOOD = JSON.stringify({ files: [{ path: 'server.js', content: CODE }, { path: 'b.js', content: '1' }], notes: "it's ok" });

// ---------- Response Doctor corpus ----------
const CORPUS = {
  'trailing comma': GOOD.replace(/\}$/, ',}'),
  'trailing comma in array': '{"files":[{"path":"a","content":"x"},],"n":1}',
  'fenced json': 'Sure!\n```json\n' + GOOD + '\n```\nbye',
  'fenced no language': '```\n' + GOOD + '\n```',
  'prose around': 'Here you go: ' + GOOD + ' hope it helps',
  'BOM': '\ufeff' + GOOD,
  'reasoning tags': '<think>hmm {x}</think>' + GOOD,
  'single quotes': "{'files':[{'path':'a.js','content':'x'}]}",
  'unquoted keys': '{files:[{path:"a.js",content:"x"}]}',
  'python literals': '{"ok":True,"v":None,"x":False}',
  'line comments': '{\n // c\n "a":1,\n "b":2\n}',
  'block comments': '{ /* b */ "a":1, "b":2 }',
  'raw newline in string': '{"files":[{"path":"a.js","content":"line1\nline2\tTab"}]}',
  'template literal value': '{"files":[{"path":"a.js","content":`console.log("hi")\nx`}]}',
  'string concatenation': '{"a":"foo" + "bar"}',
  'missing comma between values': '{"a":1 "b":2}',
  'missing comma between objects': '{"files":[{"path":"a"} {"path":"b"}]}',
  'unescaped inner quote': '{"a":"say "hi" now","b":2}',
  'smart quotes as delimiters': '{\u201Ca\u201D:1}',
  'duplicate comma': '{"a":1,,"b":2}',
  'escaped apostrophe': '{"a":"it\\\'s"}',
  'bare array of files': JSON.stringify([{ path: 'a.js', content: '1' }]),
  'files as object map': JSON.stringify({ files: { 'a.js': '1', 'b.js': '2' } }),
  'nested result container': JSON.stringify({ result: { files: [{ filename: 'a.js', code: '1' }] } }),
  'content as array of lines': JSON.stringify({ files: [{ path: 'a.js', content: ['l1', 'l2'] }] }),
  'truncated after a complete file': GOOD.slice(0, GOOD.indexOf('"b.js"') - 8),
  'truncated tail': GOOD.slice(0, -12),
  'truncated fenced': '```json\n' + GOOD.slice(0, GOOD.length - 30),
};

for (const [name, text] of Object.entries(CORPUS)) {
  test(`doctor repairs or salvages: ${name}`, () => {
    const r = parseJsonLenient(text);
    assert.equal(r.ok, true, `${name}: ${r.trace?.join('>')}`);
    assert.ok(r.value && typeof r.value === 'object');
  });
}

test('doctor never fabricates data from garbage or from a cut inside the very first file', () => {
  const cutInsideFirstFile = GOOD.slice(0, GOOD.indexOf('const a') + 15);
  for (const garbage of ['totally broken {{{', 'no json here', '', '{"a":', '[', '{', cutInsideFirstFile]) {
    const r = parseJsonLenient(garbage);
    assert.equal(r.ok, false, `garbage accepted: ${JSON.stringify(garbage)}`);
  }
});

test('doctor never alters the content inside string values (comments, quotes, braces survive)', () => {
  for (const key of ['trailing comma', 'fenced json', 'prose around', 'BOM', 'reasoning tags', 'truncated tail']) {
    const r = parseJsonLenient(CORPUS[key]);
    const v = normalizeShape(r.value);
    assert.equal(v.files[0].content, CODE, key);
  }
});

test('truncation keeps every complete file and flags the result as partial', () => {
  const files = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.js`, content: `// file ${i}\n` + 'x'.repeat(200) }));
  const full = JSON.stringify({ files, notes: 'ok' });
  const cut = full.slice(0, full.indexOf('"path":"f6.js"') + 60); // cut inside the 7th file
  const r = parseJsonLenient(cut);
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.equal(r.value.files.length, 6);
  assert.equal(r.value.files[5].path, 'f5.js');
  assert.equal(r.salvaged.files, 6);
});

test('closeTruncatedJson leaves complete documents untouched', () => {
  assert.deepEqual(closeTruncatedJson('{"a":1}'), { text: '{"a":1}', closed: false, droppedChars: 0 });
});

test('NEED_FILES protocol parses text and JSON forms; file blocks salvage', () => {
  assert.deepEqual(parseNeedFiles('x [NEED_FILES: server.js, public/game.js:10-40] y'), ['server.js', 'public/game.js:10-40']);
  assert.deepEqual(parseNeedFiles('{"need_files":["a.js"]}'), ['a.js']);
  assert.deepEqual(parseNeedFiles('nothing'), []);
  const blocks = salvageFileBlocks('<<<FILE path="a.js">>>\nA\n<<<END FILE>>>\n<<<FILE path="b.js">>>\nB\n<<<END FILE>>>\n<<<FILE path="c.js">>>\ncut');
  assert.deepEqual(blocks.map((b) => b.path), ['a.js', 'b.js']);
});

// ---------- client ----------
test('classifyError uses word boundaries (a "401" inside an id is not an auth error)', () => {
  assert.equal(classifyError(new Error('Gemini HTTP 500: request id 7f401a9c internal error')), 'AI_UNAVAILABLE');
  assert.equal(classifyError(new Error('Gemini HTTP 401: API key not valid')), 'AI_AUTH');
  assert.equal(classifyError(new Error('Gemini HTTP 404: model is no longer available')), 'AI_MODEL_UNAVAILABLE');
  assert.equal(classifyError(new Error('Gemini HTTP 429: rate limit')), 'AI_RATE_LIMIT');
  assert.equal(classifyError(new Error('The operation was aborted due to timeout')), 'AI_TIMEOUT');
});

test('a timeout is never retried identically; a transient error is retried once with a FRESH signal', async () => {
  resetBreakers();
  let calls = 0;
  await assert.rejects(call({ complete: async () => { calls++; throw Object.assign(new Error('ai-request timed out after 1000ms'), { name: 'TimeoutError' }); } }, { task: 'USER_CHAT', timeoutMs: 1000 }));
  assert.equal(calls, 1);
  resetBreakers();
  const signals = [];
  const r = await call({ complete: async (o) => { signals.push(o.signal); if (signals.length === 1) throw new Error('HTTP 503 service unavailable'); return { text: 'ok', provider: 'x' }; } }, { task: 'USER_CHAT', timeoutMs: 5000 });
  assert.equal(r.text, 'ok');
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1].aborted, false);
  resetBreakers();
});

test('timeoutMs reaches the provider layer (providers no longer hard-code 45 s / 60 s)', async () => {
  resetBreakers();
  let seen = 0;
  await call({ complete: async (o) => { seen = o.timeoutMs; return { text: 'ok' }; } }, { task: 'CODING', output: 'files' });
  assert.equal(seen, 240000);
  resetBreakers();
});

test('callJson: schema mismatch gets ONE targeted correction retry, then a recoverable AI_RESPONSE_MALFORMED', async () => {
  resetBreakers();
  const prompts = [];
  const ai = { complete: async (o) => { prompts.push(o.prompt); return { text: prompts.length === 1 ? '{"short":"x"}' : '{"files":[{"path":"a","content":"b"}]}', provider: 'p' }; } };
  const r = await callJson(ai, { task: 'CODING', prompt: 'P', validateJson: (v) => Array.isArray(v.files) });
  assert.equal(r.json.files.length, 1);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /did not contain the required fields/);
  resetBreakers();
  const bad = { complete: async () => ({ text: 'nonsense', provider: 'p' }) };
  await assert.rejects(callJson(bad, { task: 'CODING', prompt: 'P' }), (e) => e.code === 'AI_RESPONSE_MALFORMED' && e.recoverable === true);
  resetBreakers();
});

test('callJson returns a NEED_FILES request instead of throwing it away', async () => {
  resetBreakers();
  const ai = { complete: async () => ({ text: '[NEED_FILES: server.js]', provider: 'p' }) };
  const r = await callJson(ai, { task: 'DEBUGGING', prompt: 'P', allowNeedFiles: true, validateJson: (v) => Array.isArray(v.files) });
  assert.deepEqual(r.needFiles, ['server.js']);
  resetBreakers();
});

test('interpretJsonAnswer reports why an answer is unusable', () => {
  assert.equal(interpretJsonAnswer({ text: 'zzz' }, null).reason, 'not-json');
  assert.equal(interpretJsonAnswer({ text: '{"a":1}' }, (v) => Array.isArray(v.files)).reason, 'schema');
  assert.equal(interpretJsonAnswer({ text: '{"files":[]}' }, (v) => Array.isArray(v.files)).ok, true);
});

// ---------- hub ladder ----------
function memDb() {
  const store = new Map();
  return { setting(k, f) { return store.has(k) ? store.get(k) : f; }, setSetting(k, v) { store.set(k, v); } };
}

test('fallbackLadder prefers one model per connection first, then deeper models, bounded', () => {
  const a = { conn: { id: 'A' }, model: 'a1' };
  const a2 = { conn: { id: 'A' }, model: 'a2' };
  const b = { conn: { id: 'B' }, model: 'b1' };
  const out = fallbackLadder([a, a2, b, a], 3);
  assert.deepEqual(out.map((p) => p.model), ['a1', 'b1', 'a2']);
  assert.equal(fallbackLadder([a, a2, b], 1).length, 1);
});

test('hub AUTO mode falls over to another connection; a locked user model does not', async () => {
  const cfg = { ai: { deepseekKey: 'sk-d', deepseekModel: 'deepseek-chat', geminiKey: 'AIza-g', geminiModel: 'gemini-3.8-flash' } };
  const hub = new AIProviderHub({ cfg, db: memDb(), log: { warn() {} } });
  const used = [];
  hub.adapter = (conn) => ({ complete: async ({ model }) => { used.push(`${conn.provider}/${model}`); if (conn.provider === hub.publicState().connections[0].provider) throw new Error('HTTP 503 overloaded'); return { text: 'ok', provider: conn.provider, model, durationMs: 1, tokens: 1 }; } });
  const r = await hub.execute({ task: 'USER_CHAT', prompt: 'hi', system: '', timeoutMs: 5000 });
  assert.equal(r.text, 'ok');
  assert.ok(used.length >= 2, `expected a fallback, got ${used.join(',')}`);
});
