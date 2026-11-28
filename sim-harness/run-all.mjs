#!/usr/bin/env node
/**
 * Self-contained simulation runner (npm run sim).
 * Starts the REAL Builder server against a scripted mock AI (mockai.mjs) in a temp dir and exercises
 * Create / Improve / Import / failure-recovery scenarios. Exit code 1 if any scenario fails.
 *   SIM_ZIP=/path/app.zip   optional: also import a zip with npm forced offline (env-failure scenario)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIM = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-sim-'));
const PORT = 18000 + Math.floor(Math.random() * 1500);
const B = `http://127.0.0.1:${PORT}`;
for (const d of ['data', 'ws', 'projects']) fs.mkdirSync(path.join(SIM, d), { recursive: true });
fs.writeFileSync(path.join(SIM, 'scenario.json'), '{}');

const server = spawn(process.execPath, ['--import', path.join(ROOT, 'sim-harness/mockai.mjs'), 'src/server.js'], {
  cwd: ROOT,
  env: { ...process.env, SIM_DIR: SIM, npm_config_offline: 'true', PORT: String(PORT), BIND: '127.0.0.1', DATA_DIR: path.join(SIM, 'data'), WORKSPACE_DIR: path.join(SIM, 'ws'), PROJECTS_DIR: path.join(SIM, 'projects'), DEEPSEEK_API_KEY: 'sk-fake', AI_PROVIDER: 'deepseek', PREVIEW_REQUIRE_INTERNET: 'false', PREVIEW_REQUIRE_BROWSER_TEST: 'false', SHFH_ENABLED: '0' },
  stdio: ['ignore', fs.openSync(path.join(SIM, 'server.log'), 'w'), 'inherit'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, body) => { const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const get = async (p) => (await fetch(B + p)).json();
const scenario = (o) => fs.writeFileSync(path.join(SIM, 'scenario.json'), JSON.stringify(o));
const aiCalls = () => { try { return fs.readFileSync(path.join(SIM, 'ai.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
async function waitJob(id, max = 120000) {
  const t0 = Date.now();
  for (;;) {
    const j = await get('/api/jobs/' + id);
    if (['done', 'failed', 'cancelled', 'paused'].includes(j.status)) return j;
    if (Date.now() - t0 > max) throw new Error('job timeout');
    await sleep(250);
  }
}
const projectBySlug = async (slug) => { const l = await get('/api/projects'); return (l.projects || l).find((x) => x.slug === slug); };
const src = (slug, rel) => path.join(SIM, 'projects', slug, 'source', rel);
const read = (slug, rel) => fs.readFileSync(src(slug, rel), 'utf8');
const results = [];
async function scn(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, detail: detail || '', ms: Date.now() - t0 }); }
  catch (e) { results.push({ name, ok: false, detail: String(e.message || e).slice(0, 220), ms: Date.now() - t0 }); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function createApp(idea, slug) {
  const r = await post('/api/projects', { idea, autoBuild: true });
  const j = await waitJob(r.jobId);
  assert(j.status === 'done', `create job ${j.status}: ${j.error || ''}`);
  return projectBySlug(slug || 'focus-timer');
}
async function improve(p, feedback) { const r = await post(`/api/projects/${p.id}/improve`, { feedback }); return waitJob(r.jobId); }

try {
  for (let i = 0; i < 60; i++) { try { const h = await get('/health'); if (h.status === 'ok') break; } catch { /* starting */ } await sleep(300); }

  let app;
  await scn('create: well-behaved AI', async () => { const before = aiCalls(); app = await createApp('A focus timer app with a task list'); assert(fs.existsSync(src(app.slug, 'server.js')), 'server.js missing'); return `${aiCalls() - before} AI calls`; });
  const slug = app?.slug || 'focus-timer';
  const idx = () => read(slug, 'public/index.html');
  const srv = () => read(slug, 'server.js');

  for (const [label, mode] of [['trailing comma in JSON', 'badjson'], ['AI answer wrapped in prose + fence', 'fenced'], ['truncated AI answer', 'truncated']]) {
    await scn(`create: ${label}`, async () => { scenario({ codeMode: mode }); const p = await createApp('A habit tracker app', null).catch(() => null); scenario({}); const l = await get('/api/projects'); const last = (l.projects || l).slice(-1)[0]; assert(last && fs.existsSync(src(last.slug, 'server.js')), 'no server.js'); return 'built'; });
  }
  await scn('create: AI omits Dockerfile/test.js/.env.example → generated locally, 0 repair calls', async () => {
    scenario({ omit: ['Dockerfile', 'test.js', '.env.example'] }); const before = aiCalls();
    const r = await post('/api/projects', { idea: 'A notes app', autoBuild: true }); await waitJob(r.jobId); scenario({});
    const l = await get('/api/projects'); const last = (l.projects || l).slice(-1)[0];
    for (const f of ['Dockerfile', 'test.js', '.env.example']) assert(fs.existsSync(src(last.slug, f)), `${f} missing`);
    assert(aiCalls() - before === 3, `expected 3 AI calls, got ${aiCalls() - before}`); return '3 AI calls';
  });

  await scn('improve: good change is applied and reported honestly', async () => {
    scenario({ patch: { root_cause: 'x', files: [{ path: 'public/index.html', content: idx().replace('<h1>Focus Timer</h1>', '<h1>Focus Timer</h1><button id="theme">T</button>') }], explanation: 'toggle', risk: 'low' } });
    const j = await improve(app, 'Add a dark mode toggle'); assert(['done', 'partial'].includes(j.result?.outcome), `outcome ${j.result?.outcome}`); assert(idx().includes('id="theme"'), 'change missing'); return j.result.outcome;
  });
  await scn('improve: syntax-broken proposal never reaches disk (needs_action)', async () => {
    const before = srv(); scenario({ patch: { root_cause: 'x', files: [{ path: 'server.js', content: before.replace('const PORT', 'const PORT = (') }], explanation: 'oops', risk: 'low' } });
    const j = await improve(app, 'Change the port'); assert(srv() === before, 'server.js changed'); assert(j.result?.outcome === 'needs_action', `outcome ${j.result?.outcome}`); return 'blocked before writing';
  });
  await scn('improve: hallucinated path src/server.js is rejected (no stray file, no half patch)', async () => {
    const before = idx(); scenario({ patch: { root_cause: 'x', files: [{ path: 'src/server.js', content: 'console.log(1)' }, { path: 'public/index.html', content: before.replace('Focus Timer', 'FT') }], explanation: 'x', risk: 'low' } });
    const j = await improve(app, 'Rename the title'); assert(!fs.existsSync(src(slug, 'src')), 'stray src/ created'); assert(idx() === before, 'half patch applied'); assert(j.result?.outcome === 'needs_action', `outcome ${j.result?.outcome}`); return 'rejected whole';
  });
  await scn('improve: files:[] is no_change (not "verified")', async () => {
    scenario({ patch: { root_cause: 'x', files: [], explanation: 'n/a', risk: 'low' } });
    const j = await improve(app, 'Make it better'); assert(j.result?.outcome === 'no_change', `outcome ${j.result?.outcome}`); assert(!/verified/i.test(j.result?.brief || ''), 'claims verified'); return 'honest';
  });
  const bad = () => ({ root_cause: 'x', files: [{ path: 'server.js', content: srv().replace("req.url==='/health'", "req.url==='/healthz'") }], explanation: 'renamed health', risk: 'medium' });
  const good = () => ({ root_cause: 'y', files: [{ path: 'public/index.html', content: idx().replace('<h1>Focus Timer</h1>', '<h1>Focus Timer</h1><p id="note">fixed</p>') }], explanation: 'added note', risk: 'medium' });
  await scn('improve: verification fails → real error sent to AI → corrected change applied (attempts=2)', async () => {
    const before = srv(); scenario({ patchSeq: [bad(), good()], seqId: 'loop' + Date.now() });
    const j = await improve(app, 'Add a small note under the title'); assert(j.result?.attempts === 2, `attempts ${j.result?.attempts}`); assert(['done', 'partial'].includes(j.result?.outcome), `outcome ${j.result?.outcome}`); assert(srv() === before, 'server.js not restored'); return 'self-corrected';
  });
  await scn('improve: always failing change → clean rollback (rolled_back, 3 attempts)', async () => {
    const before = srv(); scenario({ patchSeq: [bad()], seqId: 'bad' + Date.now() });
    const j = await improve(app, 'Add another note'); assert(j.result?.outcome === 'rolled_back', `outcome ${j.result?.outcome}`); assert(srv() === before, 'server.js not restored'); return `attempts ${j.result.attempts}`;
  });
  await scn('improve: NEED_FILES (text) + anchored edits + new file + medium risk', async () => {
    scenario({ patchSeq: ['[NEED_FILES: server.js:1-3]', { root_cause: 'rooms', edits: [{ path: 'server.js', search: "const PORT=process.env.PORT||8080;", replace: "const PORT=process.env.PORT||8080; const lan=require('./lan');" }], new_files: [{ path: 'lan.js', content: 'module.exports={rooms:[]};\n' }], explanation: 'lan module', risk: 'medium' }], seqId: 'lan' + Date.now() });
    const j = await improve(app, 'Add LAN multiplayer rooms'); assert(fs.existsSync(src(slug, 'lan.js')), 'lan.js missing'); assert(srv().includes("require('./lan')"), 'edit missing'); return j.result.outcome;
  });
  await scn('improve: Vietnamese request → Vietnamese outcome message', async () => {
    scenario({ patch: { root_cause: 'x', files: [], explanation: 'n/a', risk: 'low' } });
    const j = await improve(app, 'Thêm chế độ tối cho ứng dụng'); assert(/Không có thay đổi|AI không đề xuất/.test(j.result?.brief || ''), `brief: ${j.result?.brief}`); return 'vi';
  });

  if (process.env.SIM_ZIP) {
    await scn('import: failing npm install (offline) → unverified, 0 AI repair calls, fast', async () => {
      scenario({}); const before = aiCalls(); const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(process.env.SIM_ZIP)]), 'app.zip'); fd.append('idea', 'Imported app');
      const t0 = Date.now(); const r = await (await fetch(B + '/api/projects/import', { method: 'POST', body: fd })).json(); const j = await waitJob(r.jobId, 90000);
      assert(j.status === 'done', `import ${j.status}`); assert(aiCalls() === before, `AI repair calls: ${aiCalls() - before}`); assert(Date.now() - t0 < 40000, 'too slow'); return `${((Date.now() - t0) / 1000).toFixed(1)}s, 0 AI calls`;
    });
  }
} finally {
  server.kill('SIGTERM');
}
const w = Math.max(...results.map((r) => r.name.length));
console.log(`\nBuilder simulation (${results.length} scenarios, mock AI, temp dir ${SIM})`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}  (${(r.ms / 1000).toFixed(1)}s)`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} scenario(s) FAILED` : '\nAll scenarios passed');
process.exit(failed ? 1 : 0);
