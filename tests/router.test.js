import test from 'node:test';
import assert from 'node:assert/strict';
import { preRoute, routeIntent, actionToIntent, isFastPath, isMultiStep } from '../src/router/intent.js';

test('GitHub URL pre-routes to UPGRADE_IMPORT', () => {
  const r = preRoute({ message: 'https://github.com/cannoi/demo-app' });
  assert.equal(r.intent, 'UPGRADE_IMPORT');
  assert.equal(r.fastPath, true);
});

test('ZIP attachment pre-routes IMPORT', () => {
  const r = preRoute({ message: '', files: [{ name: 'app.zip' }] });
  assert.equal(r.intent, 'IMPORT');
});

test('routeIntent improve verbs → MODIFY when project open', () => {
  const r = routeIntent({ message: 'đổi màu nền sang xanh', hasProject: true });
  assert.equal(r.intent, 'MODIFY');
});

test('routeIntent publish', () => {
  const r = routeIntent({ message: 'publish my app', hasProject: true });
  assert.equal(r.intent, 'PUBLISH');
  assert.equal(isFastPath(r, 'publish my app'), false);
});

test('multi-step is not fast path', () => {
  assert.equal(isMultiStep('chạy thử rồi xuất bản'), true);
  const r = routeIntent({ message: 'chạy thử rồi xuất bản', hasProject: true });
  assert.equal(isFastPath(r, 'chạy thử rồi xuất bản'), false);
  const r2 = routeIntent({ message: 'đổi màu nút rồi chạy thử', hasProject: true });
  assert.equal(isFastPath(r2, 'đổi màu nút rồi chạy thử'), false);
});

test('UNDO intent', () => {
  const r = routeIntent({ message: 'hoàn tác', hasProject: true });
  assert.equal(r.intent, 'UNDO');
});

test('actionToIntent mapping', () => {
  assert.equal(actionToIntent('export'), 'EXPORT');
  assert.equal(actionToIntent('run'), 'RUN');
  assert.equal(actionToIntent('improve', { hasProject: false }), 'CREATE');
});

test('medium risk allowed conceptually (router does not force low)', () => {
  const r = routeIntent({
    message: 'add payment',
    hasProject: true,
    aiResult: { intent: 'MODIFY', confidence: 0.8, risk: 'medium', steps: ['MODIFY'] },
  });
  assert.equal(r.intent, 'MODIFY');
  assert.equal(r.risk, 'medium');
});
