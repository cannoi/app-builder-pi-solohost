import test from 'node:test';
import assert from 'node:assert/strict';
import { fewShotBlock } from '../src/ai/few-shot-examples.js';
import { codePrompt } from '../src/ai/prompts.js';

test('few-shot block mentions product depth examples', () => {
  const b = fewShotBlock();
  assert.match(b, /Task list|quiz|contact form/i);
  assert.match(b, /Anti-patterns/i);
});

test('codePrompt includes few-shot depth examples', () => {
  const prompt = codePrompt(
    { name: 'Demo', idea: 'a small notes app' },
    { screens: [{ id: 'home', title: 'Home' }], user_stories: ['As a user I add a note'], acceptance_checks: ['Health OK'] },
  );
  assert.match(prompt, /EXAMPLE A|Task list/i);
  assert.match(prompt, /Product requirements/i);
});
