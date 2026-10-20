import test from 'node:test';
import assert from 'node:assert/strict';
import { inferAction, isQuestion } from '../src/scripts/ops.js';

test('feature change with login/register nouns → improve', () => {
  assert.equal(inferAction('thêm chức năng đăng nhập'), 'improve');
  assert.equal(inferAction('thêm form đăng ký và đăng nhập'), 'improve');
  assert.equal(inferAction('hãy sửa nút đăng nhập bị lỗi'), 'improve');
  assert.equal(inferAction('thêm nút tải file về máy'), 'improve');
  assert.equal(inferAction('thêm tính năng export csv'), 'improve');
  assert.equal(inferAction('đổi màu nền sang xanh'), 'improve');
  assert.equal(inferAction('add a dark mode toggle'), 'improve');
});

test('questions are reply not publish/export/build', () => {
  assert.equal(isQuestion('làm sao để publish lên github?'), true);
  assert.equal(inferAction('làm sao để publish lên github?'), 'reply');
  assert.equal(inferAction('how do I publish my app?'), 'reply');
  assert.equal(inferAction('app của tôi có cần download gì không'), 'reply');
});

test('create app with tải is build not export', () => {
  assert.equal(inferAction('tạo app tải video youtube'), 'build');
});

test('publish and export and run with clear objects', () => {
  assert.equal(inferAction('publish my app'), 'publish');
  assert.equal(inferAction('xuất bản app lên SoloHost'), 'publish');
  assert.equal(inferAction('tải zip bộ cài'), 'export');
  assert.equal(inferAction('chạy thử app'), 'run');
  assert.equal(inferAction('open the preview'), 'run');
});

test('release notes alone is not publish', () => {
  assert.notEqual(inferAction('game rắn có bảng điểm release notes'), 'publish');
});

test('standalone download is not export', () => {
  assert.notEqual(inferAction('download'), 'export');
  assert.notEqual(inferAction('tải'), 'export');
});

test('GHCR + solohost keywords → export', () => {
  assert.equal(inferAction('cài đặt solohost image ghcr.io/demo/app:latest docker-compose'), 'export');
});
