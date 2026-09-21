import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubImageUploader } from '../src/github/uploader.js';

test('GitHub image uploader follows the repository default branch', async () => {
  const calls = [];
  const transport = {
    async fetch(url, options) {
      calls.push({ url, options });
      if (url.endsWith('/repos/alice/demo')) {
        return { ok: true, status: 200, async json() { return { default_branch: 'develop' }; } };
      }
      if (url.includes('/contents/assets/logo.png?ref=develop')) {
        return { ok: false, status: 404, async text() { return ''; } };
      }
      if (url.endsWith('/contents/assets/logo.png')) {
        return { ok: true, status: 201, async json() { return { content: { sha: 'blob-sha' } }; } };
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    },
  };
  const uploader = new GitHubImageUploader({ getToken: () => 'token' }, transport);
  const result = await uploader.uploadImage('https://github.com/alice/demo', 'assets/logo.png', Buffer.from('image'));
  assert.equal(result.branch, 'develop');
  assert.match(result.cdn_url, /@develop\/assets\/logo\.png$/);
  const put = calls.find((call) => call.options.method === 'PUT');
  assert.equal(JSON.parse(put.options.body).branch, 'develop');
});