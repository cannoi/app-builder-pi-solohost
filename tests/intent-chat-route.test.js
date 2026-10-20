import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('chat routes never enqueue release with push:true from keywords alone', () => {
  const src = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  // Project chat should not have type: 'release' in the intent fast path section after our fix
  const pchat = src.slice(src.indexOf("/api/projects/:id/chat"), src.indexOf("/api/projects/:id/attachments"));
  assert.doesNotMatch(pchat, /type:\s*'release'/);
  assert.match(pchat, /builder_chat/);
  assert.match(pchat, /via:\s*'builder_chat'|builder_chat/);
});

test('no-project guidance for publish/run', () => {
  const src = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.match(src, /Chưa có app/);
  assert.match(src, /No app yet/);
});

test('pipeline high risk only', () => {
  const src = fs.readFileSync(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(src, /declaredRisk === 'high'/);
});

test('export_zip job handler exists', () => {
  const src = fs.readFileSync(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(src, /jobs\.on\('export_zip'/);
});

test('MODIFY assigns job._files', () => {
  const src = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.match(src, /type:\s*'improve'[\s\S]{0,400}job\._files\s*=\s*files/);
});
