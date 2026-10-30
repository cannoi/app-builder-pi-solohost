# GitHub Upload module (SoloHost Builders)

Git-**first** publish of a source folder to GitHub. Plain language errors + one action for ordinary users.

## Install into an app

Copy `modules/github-upload` into your app (or npm link). Needs: Node 20+, `git` on PATH, optional `@octokit/rest` only for repo create / account check.

## Minimal usage

```js
import { publishSourceToGitHub, explainGitHubError } from './modules/github-upload/src/index.js';

const result = await publishSourceToGitHub({
  token: process.env.GITHUB_TOKEN,
  owner: 'myuser',           // optional; defaults to token user
  repo: 'my-app',
  sourceDir: '/path/to/project',
  branch: 'main',
  version: '1.0.0',
  force: true,               // overwrite remote main when needed
  onProgress: (msg) => console.log(msg),
});

if (!result.ok) {
  console.log(result.userTitle);
  console.log(result.userDetail);
  console.log(result.userAction);
}
```

## Token (classic PAT)

https://github.com/settings/tokens/new — enable **repo**, **workflow**, **write:packages**.

## Order of operations

1. Check token (`GET /user`) and scopes when header is present  
2. Ensure repository exists (create if missing)  
3. **`git` push** (force-with-lease when `force: true`)  
4. Only if `git` is unavailable: GitHub Contents/Git Data API  

