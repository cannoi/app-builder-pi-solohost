import test from 'node:test';
import assert from 'node:assert/strict';
import { runVisualCheck } from '../src/engine/visual-check.js';

test('skips when no playwright', async () => {
  const r = await runVisualCheck({
    previewUrl: 'http://127.0.0.1:9',
    playwrightModule: {},
  });
  assert.equal(r.status, 'unverified');
  assert.equal(r.reason, 'no_playwright');
});

test('skips when no preview url', async () => {
  const r = await runVisualCheck({});
  assert.equal(r.status, 'unverified');
});

test('skips vision when ai has no images support path', async () => {
  const r = await runVisualCheck({
    previewUrl: 'http://127.0.0.1:9',
    playwrightModule: {
      async capturePreviewScreens() {
        return { shots: [{ name: 'a.png', buffer: Buffer.from('x') }] };
      },
    },
    ai: {
      async completeJson() { throw new Error('no vision'); },
    },
  });
  assert.ok(r.status === 'done' || r.status === 'unverified');
  // vision failure is soft
  if (r.status === 'done') assert.equal(r.vision, null);
});
