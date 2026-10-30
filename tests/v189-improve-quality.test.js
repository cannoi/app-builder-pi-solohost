import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyEdits, describeEditErrors } from '../src/jobs/edits.js';
import { syntaxCheckFiles } from '../src/jobs/syntax-check.js';
import { requestImprovePatch, loadNeedFileSnippets } from '../src/jobs/improve-ai-cycle.js';
import { ensureBoilerplate, detectEntry } from '../src/jobs/scaffolds.js';
import { classifyFailure } from '../src/testing/classify-failure.js';
import { runNodeTests, installTimeoutMs } from '../src/testing/engine.js';
import { buildAiProjectContext } from '../src/services/project-context-resolver.js';
import { outcomeBrief, mapPatchResult, localeOf, OUTCOMES } from '../src/jobs/outcomes.js';
import { patchPrompt } from '../src/ai/prompts.js';

async function tmp(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf189-'));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

// ---------- edits ----------
test('edits: exact-once rule, atomic batch, CRLF preserved, helpful errors', async () => {
  const dir = await tmp({ 'a.js': 'const a = 1;\r\nconst b = 2;\r\n', 'b.js': 'x\nx\n' });
  const ok = await applyEdits({ sourceDir: dir, edits: [{ path: 'a.js', search: 'const b = 2;', replace: 'const b = 3;' }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.files[0].content, 'const a = 1;\r\nconst b = 3;\r\n');
  const amb = await applyEdits({ sourceDir: dir, edits: [{ path: 'b.js', search: 'x', replace: 'y' }] });
  assert.equal(amb.ok, false);
  assert.equal(amb.errors[0].reason, 'ambiguous');
  const miss = await applyEdits({ sourceDir: dir, edits: [{ path: 'a.js', search: 'const c = 9;', replace: 'z' }, { path: 'a.js', search: 'const a = 1;', replace: 'const a = 5;' }] });
  assert.equal(miss.ok, false); // atomic: the valid second edit is NOT returned
  assert.deepEqual(miss.files, []);
  assert.match(describeEditErrors(miss.errors), /not_found/);
  const gone = await applyEdits({ sourceDir: dir, edits: [{ path: 'nope.js', search: 'a', replace: 'b' }] });
  assert.equal(gone.errors[0].reason, 'file_missing');
});

test('edits: sequential edits of one file see the previous result', async () => {
  const dir = await tmp({ 'a.js': 'one two three' });
  const r = await applyEdits({ sourceDir: dir, edits: [{ path: 'a.js', search: 'two', replace: 'TWO' }, { path: 'a.js', search: 'one TWO', replace: '1 2' }] });
  assert.equal(r.files[0].content, '1 2 three');
});

// ---------- syntax gate ----------
test('syntax gate catches JS and JSON errors before anything is written', async () => {
  const r = await syntaxCheckFiles([{ path: 'a.js', content: 'const x = (;' }, { path: 'ok.js', content: 'const y = 1;' }, { path: 'c.json', content: '{bad' }, { path: 'm.mjs', content: 'import fs from "node:fs"; export const z = fs;' }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.path).sort(), ['a.js', 'c.json']);
});

// ---------- improve cycle ----------
function fakeAi(answers, seenPrompts = []) {
  let i = 0;
  return {
    seenPrompts,
    async completeJson(opts) {
      seenPrompts.push(opts.prompt);
      const a = answers[Math.min(i++, answers.length - 1)];
      if (typeof a === 'string') return { text: a, json: null, needFiles: /NEED_FILES/.test(a) ? ['server.js:1-2'] : [] };
      return { text: JSON.stringify(a), json: a };
    },
  };
}
const run = (ai, dir, extra = {}) => requestImprovePatch({ ai, SYSTEM: 'S', patchPrompt: (p, e, ctx, fb) => `PROMPT ${ctx} ${fb}`, project: { id: 'p', name: 'n', idea: 'i' }, feedback: 'do it', contextText: 'CTX', sourceDir: dir, language: 'English', ...extra });

test('improve cycle: NEED_FILES is honored (text form) and the next prompt contains the requested lines', async () => {
  const dir = await tmp({ 'server.js': 'line1\nline2\nline3\n' });
  const ai = fakeAi(['[NEED_FILES: server.js:1-2]', { root_cause: 'x', edits: [{ path: 'server.js', search: 'line2', replace: 'LINE2' }], explanation: 'e', risk: 'low' }]);
  const r = await run(ai, dir);
  assert.equal(r.ok, true);
  assert.equal(ai.seenPrompts.length, 2);
  assert.match(ai.seenPrompts[1], /ADDITIONAL FILES/);
  assert.match(ai.seenPrompts[1], /line1\nline2/);
  assert.equal(r.files[0].content, 'line1\nLINE2\nline3\n');
});

test('improve cycle: new_files allowed, medium risk passes through', async () => {
  const dir = await tmp({ 'server.js': 'console.log(1);\n' });
  const ai = fakeAi([{ root_cause: 'x', new_files: [{ path: 'lan.js', content: 'module.exports = {};\n' }], edits: [{ path: 'server.js', search: 'console.log(1);', replace: "require('./lan');\nconsole.log(1);" }], explanation: 'e', risk: 'medium' }]);
  const r = await run(ai, dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.created, ['lan.js']);
  assert.equal(r.risk, 'medium');
});

test('improve cycle: syntax error → the problem goes back to the AI → corrected answer is used', async () => {
  const dir = await tmp({ 'server.js': 'const a = 1;\n' });
  const bad = { root_cause: 'x', files: [{ path: 'server.js', content: 'const a = (;' }], explanation: 'bad', risk: 'low' };
  const good = { root_cause: 'x', files: [{ path: 'server.js', content: 'const a = 2;\n' }], explanation: 'good', risk: 'low' };
  const ai = fakeAi([bad, good]);
  const r = await run(ai, dir);
  assert.equal(r.ok, true);
  assert.match(ai.seenPrompts[1], /PROBLEM WITH YOUR PREVIOUS ANSWER/);
  assert.match(ai.seenPrompts[1], /Syntax errors/);
  assert.equal(r.files[0].content, 'const a = 2;\n');
});

test('improve cycle: unfixable syntax → needs_action with an honest reason, nothing returned to write', async () => {
  const dir = await tmp({ 'server.js': 'const a = 1;\n' });
  const bad = { root_cause: 'x', files: [{ path: 'server.js', content: 'const a = (;' }], explanation: 'bad', risk: 'low' };
  const r = await run(fakeAi([bad]), dir, { language: 'Vietnamese' });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, OUTCOMES.NEEDS_ACTION);
  assert.match(r.message, /lỗi cú pháp/);
  assert.deepEqual(r.files, []);
});

test('improve cycle: hallucinated look-alike path is sent back, never half-applied', async () => {
  const dir = await tmp({ 'server.js': 'a\n', 'public/index.html': '<h1>x</h1>\n' });
  const first = { root_cause: 'x', files: [{ path: 'src/server.js', content: 'b\n' }, { path: 'public/index.html', content: '<h1>y</h1>\n' }], explanation: 'e', risk: 'low' };
  const fixed = { root_cause: 'x', files: [{ path: 'server.js', content: 'b\n' }, { path: 'public/index.html', content: '<h1>y</h1>\n' }], explanation: 'e', risk: 'low' };
  const ai = fakeAi([first, fixed]);
  const r = await run(ai, dir);
  assert.equal(r.ok, true);
  assert.match(ai.seenPrompts[1], /did you mean "server\.js"/);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['public/index.html', 'server.js']);
});

test('improve cycle: files:[] and identical content are no_change, never "verified"', async () => {
  const dir = await tmp({ 'a.js': 'same\n' });
  const empty = await run(fakeAi([{ root_cause: 'x', files: [], explanation: 'nothing', risk: 'low' }]), dir);
  assert.equal(empty.outcome, OUTCOMES.NO_CHANGE);
  const same = await run(fakeAi([{ root_cause: 'x', files: [{ path: 'a.js', content: 'same\n' }], explanation: 'e', risk: 'low' }]), dir);
  assert.equal(same.outcome, OUTCOMES.NO_CHANGE);
  assert.doesNotMatch(empty.message + same.message, /verified/i);
});

test('loadNeedFileSnippets honors line ranges, reports missing files and skips traversal', async () => {
  const dir = await tmp({ 'g.js': Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n') });
  const out = await loadNeedFileSnippets(dir, ['g.js:10-12', '../etc/passwd', 'missing.js']);
  assert.equal(out.length, 2); // the traversal request is dropped silently
  assert.equal(out[0].content, 'L10\nL11\nL12');
  assert.equal(out[1].error, 'not found');
});

test('patch prompt documents edits, new_files, need_files and the medium-risk rule', () => {
  const t = patchPrompt({ name: 'n', idea: 'i' }, '', 'CTX', 'fb');
  for (const needle of ['"edits"', '"new_files"', 'need_files', 'medium = multi-file feature']) assert.ok(t.includes(needle), needle);
});

// ---------- scaffolds ----------
test('scaffolds generate missing standard files locally, never overwrite, and match ESM/CJS', async () => {
  const dir = await tmp({ 'package.json': JSON.stringify({ name: 'demo', type: 'module', scripts: { start: 'node app.js' } }), 'README.md': 'MINE' });
  const written = await ensureBoilerplate(dir);
  assert.ok(written.includes('Dockerfile') && written.includes('.env.example') && written.includes('test.js'));
  assert.ok(!written.includes('README.md'));
  assert.equal(await fs.readFile(path.join(dir, 'README.md'), 'utf8'), 'MINE');
  assert.match(await fs.readFile(path.join(dir, 'Dockerfile'), 'utf8'), /CMD \["node","app\.js"\]/);
  assert.match(await fs.readFile(path.join(dir, 'test.js'), 'utf8'), /^import test from 'node:test'/);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node test.js');
  assert.deepEqual(await ensureBoilerplate(dir), []); // idempotent
  assert.equal(detectEntry({ main: './srv.js' }), 'srv.js');
});

// ---------- failure classification + env-aware install ----------
test('classifyFailure separates environment problems from code problems', () => {
  assert.equal(classifyFailure('npm error code ENOTCACHED request failed').class, 'ENV_NETWORK');
  assert.equal(classifyFailure('getaddrinfo EAI_AGAIN registry.npmjs.org').class, 'ENV_NETWORK');
  assert.equal(classifyFailure('npm error code ETIMEDOUT').class, 'ENV_TIMEOUT');
  assert.equal(classifyFailure('EACCES: permission denied').class, 'ENV_DISK');
  assert.equal(classifyFailure('SyntaxError: Unexpected token }').class, 'CODE_SYNTAX');
  assert.equal(classifyFailure("Error: Cannot find module 'express'").class, 'DEPENDENCY');
  assert.equal(classifyFailure('AssertionError: expected 1').aiRepair, true);
  assert.equal(classifyFailure('npm error code ENOTCACHED').aiRepair, false);
});

test('runNodeTests: a failing install caused by the environment is reported as UNVERIFIED, not as a code failure', async () => {
  const dir = await tmp({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e 0' }, dependencies: { 'paf-nonexistent-package-zzz-189': '1.0.0' } }) });
  const old = process.env.npm_config_offline;
  process.env.npm_config_offline = 'true';
  try {
    const r = await runNodeTests(dir, 30000);
    assert.equal(r.status, 'skipped');
    assert.equal(r.unverified, true);
    assert.match(r.envFailure, /^ENV_/);
  } finally {
    if (old === undefined) delete process.env.npm_config_offline; else process.env.npm_config_offline = old;
  }
});

test('runNodeTests: no dependencies → no install step, tests run', async () => {
  const dir = await tmp({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e 0' } }) });
  const r = await runNodeTests(dir, 30000);
  assert.equal(r.status, 'passed');
});

test('install timeout scales for slow hosts and honors NPM_INSTALL_TIMEOUT_MS', () => {
  assert.ok(installTimeoutMs(45000) >= 120000);
  process.env.NPM_INSTALL_TIMEOUT_MS = '7000';
  assert.equal(installTimeoutMs(45000), 7000);
  delete process.env.NPM_INSTALL_TIMEOUT_MS;
});

// ---------- context engine ----------
test('context engine v2: backend request puts server code first, keeps whole files, drops lockfile/workflow noise', async () => {
  const big = Array.from({ length: 400 }, (_, i) => `function fn${i}(){ return ${i}; } // multiplayer ${i % 7 === 0 ? 'room' : ''}`).join('\n');
  const dir = await tmp({
    'package.json': '{"name":"g","scripts":{"start":"node server.js"}}',
    'package-lock.json': JSON.stringify({ lock: 'x'.repeat(30000) }),
    '.github/workflows/docker.yml': 'name: build\n' + 'step: x\n'.repeat(500),
    'README.md': '# readme\n' + 'doc '.repeat(2000),
    'server.js': "const express = require('express');\napp.get('/health', () => {});\n" + 'x'.repeat(2000),
    'public/game.js': big,
    'public/style.css': 'body{margin:0}',
    'public/index.html': '<html></html>',
  });
  const r = await buildAiProjectContext(null, { sourceDir: dir, query: 'Add LAN multiplayer rooms so players on the same Wi-Fi can race', mode: 'improve' });
  assert.ok(r.text.includes('--- server.js ---'), 'server.js must be included');
  assert.ok(r.text.indexOf('--- server.js ---') < r.text.indexOf('--- package-lock.json ---') || !r.text.includes('--- package-lock.json ---'));
  const lockBlock = r.text.split('--- package-lock.json ---')[1] || '';
  assert.ok(lockBlock.split('\n--- ')[0].length < 1800, 'lockfile must be tiny');
  assert.ok(r.text.length < 36000);
});

test('context engine v2: an oversized source file becomes outline + windows with named omissions (never silent clipping)', async () => {
  const lines = Array.from({ length: 1200 }, (_, i) => (i === 700 ? 'function handleMultiplayerJoin(room) { return room; }' : `const v${i} = ${i}; // filler line number ${i}`));
  const dir = await tmp({ 'server.js': lines.join('\n') });
  const r = await buildAiProjectContext(null, { sourceDir: dir, query: 'fix multiplayer join handler', mode: 'improve' });
  assert.match(r.text, /OUTLINE:/);
  assert.match(r.text, /handleMultiplayerJoin/);
  assert.match(r.text, /lines \d+-\d+ omitted/);
  assert.match(r.text, /NEED_FILES/);
});

// ---------- outcomes in the user's language ----------
test('outcomes are localized and never claim success for rollback / no change', () => {
  assert.equal(localeOf('Vietnamese'), 'vi');
  assert.equal(localeOf('English'), 'en');
  const vi = outcomeBrief(mapPatchResult({ rolledBack: true }), 'Vietnamese');
  assert.match(vi.message, /Đã hoàn tác/);
  const en = outcomeBrief(mapPatchResult({ rolledBack: true }), 'English');
  assert.match(en.message, /Rolled back/);
  assert.equal(mapPatchResult({ filesChanged: 2, verified: true }).outcome, OUTCOMES.DONE);
  assert.equal(mapPatchResult({ filesChanged: 2, verified: false, unverified: true }).outcome, OUTCOMES.PARTIAL);
  assert.equal(mapPatchResult({ filesChanged: 0 }).outcome, OUTCOMES.NO_CHANGE);
});
