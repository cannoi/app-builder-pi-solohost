import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlaywrightE2E, e2eResult } from '../src/testing/playwright.js';

test('browser E2E uses one canonical passed status', async () => {
  const browser = { async newPage() { return { async goto() {}, async title() { return 'OK'; }, async screenshot() {}, async close() {} }; }, async close() {} };
  const result = await runPlaywrightE2E({ uiUrl: 'http://preview.test', browserFactory: async () => browser });
  assert.equal(result.status, 'passed');
  assert.equal(e2eResult(result).status, 'passed');
});
