import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, isAuthError, isModelUnavailable, isTransient } from '../src/ai/hub/errors.js';
import { filterAndRankListed, isChatCapable, compareGeminiModels } from '../src/ai/hub/model-registry.js';
import { buildAttemptPlan, ROUTING_MODE } from '../src/ai/hub/routing.js';

test('A8: HTTP 500 with 401 in id is NOT AUTH_INVALID', () => {
  const cls = classifyProviderError(new Error('HTTP 500 request_id=7f401a9c failed'), 500);
  assert.notEqual(cls.code, 'AUTH_INVALID');
  assert.notEqual(cls.code, 'INVALID_CREDENTIAL');
});

test('A8: real API_KEY_INVALID is AUTH_INVALID', () => {
  const cls = classifyProviderError(new Error('API_KEY_INVALID: API key not valid'), 400);
  assert.equal(cls.code, 'AUTH_INVALID');
});

test('A8: model no longer available is MODEL_UNAVAILABLE with hint', () => {
  const cls = classifyProviderError(
    new Error('HTTP 404 models/gemini-2.5-flash is no longer available to new users. Use gemini-3.8-flash'),
    404,
  );
  assert.equal(cls.code, 'MODEL_UNAVAILABLE');
  assert.ok(cls.hint);
});

test('A7: non-chat models excluded; ranking prefers newer gemini', () => {
  const raw = [
    { id: 'gemini-2.5-flash' },
    { id: 'gemini-3.8-flash' },
    { id: 'embedding-001' },
    { id: 'imagen-3.0' },
    { id: 'gemini-3.9-flash' },
  ];
  const ranked = filterAndRankListed('gemini', raw);
  assert.ok(!ranked.some((m) => /embedding|imagen/.test(m.id)));
  assert.ok(ranked[0].id.includes('3.9') || ranked[0].id.includes('3.8'));
  assert.ok(compareGeminiModels('gemini-3.8-flash', 'gemini-2.5-flash') < 0);
});

test('A3: ladder includes up to 2 models per provider', () => {
  const plan = buildAttemptPlan({
    connections: [
      {
        id: 'g',
        provider: 'gemini',
        hasKey: true,
        status: 'VERIFIED',
        models: [
          { id: 'gemini-2.5-flash', state: 'unavailable' },
          { id: 'gemini-3.8-flash', verified: true },
          { id: 'gemini-3.9-flash' },
        ],
      },
    ],
    mode: ROUTING_MODE.AUTO,
    preferredModels: [],
    maxAttempts: 4,
  });
  assert.ok(plan.length >= 1);
  assert.ok(!plan.some((p) => p.model === 'gemini-2.5-flash'), 'skips unavailable');
  assert.ok(plan.some((p) => p.model === 'gemini-3.8-flash'));
});

test('user-selected still first then ladder continues', () => {
  const plan = buildAttemptPlan({
    connections: [
      {
        id: 'g',
        provider: 'gemini',
        hasKey: true,
        status: 'VERIFIED',
        models: [
          { id: 'gemini-2.5-flash' },
          { id: 'gemini-3.8-flash', verified: true },
        ],
      },
    ],
    mode: ROUTING_MODE.SELECTED,
    preferredModels: ['gemini:gemini-2.5-flash'],
    maxAttempts: 4,
  });
  assert.equal(plan[0].model, 'gemini-2.5-flash');
  assert.ok(plan.length >= 2, 'fallthrough models after user selection');
});

test('isChatCapable filters', () => {
  assert.equal(isChatCapable({ id: 'gemini-3.8-flash' }), true);
  assert.equal(isChatCapable({ id: 'text-embedding-004' }), false);
});

test('503 high demand is OVERLOADED not AUTH', () => {
  const cls = classifyProviderError(
    new Error('Gemini HTTP 503: { "error": { "code": 503, "message": "This model is currently experiencing high demand.", "status": "UNAVAILABLE" } }'),
    503,
  );
  assert.equal(cls.code, 'OVERLOADED');
  assert.ok(isTransient(cls.code));
});

test('ladder can offer 3 models per provider for failover', () => {
  const plan = buildAttemptPlan({
    connections: [{
      id: 'g', provider: 'gemini', hasKey: true, status: 'VERIFIED',
      models: [
        { id: 'gemini-a' },
        { id: 'gemini-b' },
        { id: 'gemini-c' },
        { id: 'gemini-d' },
      ],
    }],
    mode: ROUTING_MODE.AUTO,
    maxAttempts: 6,
  });
  assert.ok(plan.length >= 3);
});
