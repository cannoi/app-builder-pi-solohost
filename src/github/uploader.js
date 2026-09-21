const API = 'https://api.github.com';

export class GitHubImageUploader {
  constructor(github, transport = globalThis) {
    this.github = github;
    this.fetch = transport.fetch?.bind(transport) || globalThis.fetch;
  }

  /**
   * Upload image bytes through the GitHub Contents API.
   * The method is deliberately independent from AI and returns the small CDN contract only.
   */
  async uploadImage(repo, filePath, imageInput, message = 'Upload image') {
    const token = this.github.getToken();
    if (!token) throw Object.assign(new Error('GitHub token not configured'), { code: 'GITHUB_NOT_CONFIGURED' });
    const normalizedRepo = String(repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(normalizedRepo)) throw new Error('GitHub repository must be owner/repository.');
    const safePath = String(filePath || '').replace(/^\/+/, '');
    if (!safePath || safePath.includes('..')) throw new Error('Invalid GitHub image path.');
    const bytes = toBuffer(imageInput);
    if (!bytes.length) throw new Error('Image is empty.');
    const encodedRepo = normalizedRepo.split('/').map(encodeURIComponent).join('/');
    const encodedPath = safePath.split('/').map(encodeURIComponent).join('/');
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'pi-app-factory-image-uploader',
    };
    let existingSha = null;
    let branch = 'main';
    const repository = await this.fetch(`${API}/repos/${encodedRepo}`, { method: 'GET', headers });
    if (repository.ok) {
      const repoData = await repository.json();
      branch = String(repoData.default_branch || 'main');
    } else if (repository.status !== 404) {
      throw await apiError(repository, 'GitHub could not check the repository.');
    }
    const encodedBranch = encodeURIComponent(branch);
    const existing = await this.fetch(`${API}/repos/${encodedRepo}/contents/${encodedPath}?ref=${encodedBranch}`, { method: 'GET', headers });
    if (existing.ok) {
      const data = await existing.json();
      existingSha = data.sha || null;
    } else if (existing.status !== 404) {
      throw await apiError(existing, 'GitHub could not check the existing image.');
    }
    const response = await this.fetch(`${API}/repos/${encodedRepo}/contents/${encodedPath}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ message, content: bytes.toString('base64'), branch, ...(existingSha ? { sha: existingSha } : {}) }),
    });
    if (!response.ok) throw await apiError(response, 'GitHub image upload failed.');
    const result = await response.json();
    if (!result?.content?.sha) throw new Error('GitHub accepted the request but did not confirm the image content.');
    return { status: 'success', branch, cdn_url: `https://cdn.jsdelivr.net/gh/${normalizedRepo}@${branch}/${safePath}` };
  }
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') {
    const raw = input.replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(raw, 'base64');
  }
  if (input?.buffer) return toBuffer(input.buffer);
  throw new Error('Image input must be bytes or base64.');
}

async function apiError(response, fallback) {
  const text = await response.text().catch(() => '');
  let detail = text;
  try { detail = JSON.parse(text)?.message || text; } catch {}
  const err = new Error(`${fallback} HTTP ${response.status}: ${String(detail).slice(0, 500)}`);
  err.status = response.status;
  err.code = response.status === 401 || response.status === 403 ? 'auth' : response.status === 409 ? 'conflict' : response.status >= 500 ? 'server' : 'api';
  return err;
}
