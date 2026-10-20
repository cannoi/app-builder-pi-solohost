import test from 'node:test';
import assert from 'node:assert/strict';
import { detectUserLanguage } from '../src/ai/language.js';

test('Vietnamese sentences with diacritics', () => {
  assert.equal(detectUserLanguage('Tạo app quản lý bán hàng cho cửa hàng của tôi'), 'Vietnamese');
  assert.equal(detectUserLanguage('đổi màu nền sang xanh'), 'Vietnamese');
  assert.equal(detectUserLanguage('sửa lỗi không lưu được điểm'), 'Vietnamese');
});

test('Mixed VI + English tech words still Vietnamese', () => {
  assert.equal(detectUserLanguage('build app bán trà sữa'), 'Vietnamese');
  assert.equal(detectUserLanguage('Tôi cần app for kế toán'), 'Vietnamese');
});

test('English pure request', () => {
  assert.equal(detectUserLanguage('Make a snake game'), 'English');
  assert.equal(detectUserLanguage('add a dark mode toggle'), 'English');
  assert.equal(detectUserLanguage('publish my app'), 'English');
});

test('Spanish greeting', () => {
  assert.equal(detectUserLanguage('hola quiero una app'), 'Spanish');
});

test('Never returns Other; empty uses fallback', () => {
  assert.notEqual(detectUserLanguage('xyz123'), 'Other');
  assert.equal(detectUserLanguage('', { previous: 'Vietnamese' }), 'Vietnamese');
  assert.equal(detectUserLanguage(''), 'English');
});
