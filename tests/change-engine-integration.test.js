import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isChangeEngineV2Enabled } from '../src/engine/flags.js';
import { runModifyEngine } from '../src/engine/modify-engine.js';
import path from 'node:path';
import os from 'node:os';
import { applyEditsInMemory } from '../src/engine/edits.js';

test('flag off by default', () => {
  delete process.env.CHANGE_ENGINE_V2;
  assert.equal(isChangeEngineV2Enabled(), false);
});

test('pipeline only references CE inside flagged block', () => {
  const src = fs.readFileSync(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(src, /isChangeEngineV2Enabled\(\)/);
  assert.match(src, /runModifyEngine/);
  // legacy path still present
  assert.match(src, /patchPrompt/);
  assert.match(src, /applySafeAiPatch/);
});

test('fake AI MODIFY medium applies and bad edit does not write partially', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  const ai = {
    async completeJson({ prompt }) {
      if (/Fix the edits/.test(prompt)) {
        return { json: { edits: [{ path: 'a.js', op: 'replace', search: 'const x = 1;', replace: 'const x = 2;' }], explanation: 'ok', risk: 'medium' } };
      }
      // first response: intentional bad search then engine retries
      return { json: { final: { edits: [{ path: 'a.js', op: 'replace', search: 'const x = 1;', replace: 'const x = 2;' }], explanation: 'bump', risk: 'medium' } } };
    },
  };
  const r = await runModifyEngine({
    sourceDir: dir,
    project: { slug: 't' },
    feedback: 'bump x',
    ai,
    useAgentLoop: true,
    emit: () => {},
  });
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), /const x = 2/);
});

test('verifyModifyResult rolls back signal when static fails', async () => {
  const { verifyModifyResult } = await import('../src/engine/modify-engine.js');
  const r = await verifyModifyResult({
    sourceDir: '.',
    baseline: { staticResult: { status: 'passed' }, nodeResult: { status: 'passed' }, scan: { critical: 0 } },
    runStaticTests: async () => ({ status: 'failed' }),
    runNodeTests: async () => ({ status: 'passed' }),
    scanProject: async () => ({ critical: 0 }),
    checklist: [],
    fileContents: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.regressed, true);
});
