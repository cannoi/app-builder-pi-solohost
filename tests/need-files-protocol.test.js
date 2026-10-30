import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseNeedFiles } from '../src/ai/response-doctor.js';
import {
  loadNeedFileSnippets,
  inventoryOnlyContext,
  requestImprovePatch,
} from '../src/jobs/improve-ai-cycle.js';

test('parseNeedFiles: bracket form', () => {
  const n = parseNeedFiles('Please wait.\n[NEED_FILES: server.js, public/app.js:1-40]\n');
  assert.deepEqual(n, ['server.js', 'public/app.js:1-40']);
});

test('parseNeedFiles: JSON need_files', () => {
  const n = parseNeedFiles('{"need_files":["a.js","b.js"],"reason":"x"}');
  assert.ok(n.includes('a.js') && n.includes('b.js'));
});

test('loadNeedFileSnippets loads real files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-need-'));
  await fs.writeFile(path.join(dir, 'server.js'), 'export const ok = 1;\n');
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public/app.js'), 'line1\nline2\nline3\n');
  const sn = await loadNeedFileSnippets(dir, ['server.js', 'public/app.js:1-2']);
  assert.equal(sn[0].content.includes('export const ok'), true);
  assert.equal(sn[1].content.includes('line1'), true);
  assert.equal(sn[1].content.includes('line3'), false);
});

test('inventoryOnlyContext strips file bodies', () => {
  const raw = `AUTHORITATIVE SOURCE SNAPSHOT\n--- FILE INVENTORY (2 paths, names only) ---\nserver.js\npublic/app.js\n--- server.js ---\nSECRET_BODY_SHOULD_GO\n--- public/app.js ---\nOTHER\n`;
  const lean = inventoryOnlyContext(raw);
  assert.match(lean, /FILE INVENTORY/);
  assert.equal(lean.includes('SECRET_BODY_SHOULD_GO'), false);
});

test('requestImprovePatch: pick files then patch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-proto-'));
  await fs.writeFile(path.join(dir, 'server.js'), 'export function hello(){return 1}\n');
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"t"}');

  let call = 0;
  const ai = {
    async completeJson(opts) {
      call += 1;
      const prompt = String(opts.prompt || '');
      // Step 1 file pick
      if (/SELECT FILES|STEP 1\/2|need_files/i.test(prompt) && call === 1) {
        return { json: { need_files: ['server.js'], reason: 'edit hello' }, text: '{"need_files":["server.js"]}', provider: 'mock' };
      }
      // Step 2 must see ADDITIONAL FILES body
      assert.match(prompt, /ADDITIONAL FILES|export function hello/i);
      return {
        json: {
          files: [{ path: 'server.js', content: 'export function hello(){return 2}\n' }],
          risk: 'low',
          explanation: 'bump return',
        },
        text: '{"files":[{"path":"server.js","content":"export function hello(){return 2}\\n"}]}',
        provider: 'mock',
      };
    },
  };

  const events = [];
  const result = await requestImprovePatch({
    ai,
    SYSTEM: 'test',
    patchPrompt: (project, _e, ctx, feedback) => `TASK:${feedback}\n${ctx}`,
    project: { id: 'p1', name: 'T', slug: 't', idea: 'hi' },
    feedback: 'make hello return 2',
    contextText: '--- FILE INVENTORY (2 paths, names only) ---\nserver.js\npackage.json\n',
    sourceDir: dir,
    emit: (a, b, m) => events.push(`${a}:${b}:${m || ''}`),
    language: 'English',
  });

  assert.equal(result.ok, true);
  assert.equal(result.files[0].path, 'server.js');
  assert.match(result.files[0].content, /return 2/);
  assert.ok(call >= 2, `expected >=2 AI calls, got ${call}`);
  assert.ok(events.some((e) => /Step 1|selecting files|Bước 1/i.test(e)));
});
