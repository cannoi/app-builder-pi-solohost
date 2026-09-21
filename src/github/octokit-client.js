const API = 'https://api.github.com';

export async function createOctokit({ token, userAgent = 'pi-app-factory' }) {
  if (!token) throw Object.assign(new Error('GitHub token is missing.'), { code: 'GITHUB_NOT_CONFIGURED' });
  try {
    const { Octokit } = await import('@octokit/rest');
    return new Octokit({ auth: token, userAgent, request: { timeout: 30000 } });
  } catch {
    return createFetchOctokit(token, userAgent);
  }
}

function createFetchOctokit(token, userAgent) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
  };
  async function request(method, url, body) {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${String(data.message || text).slice(0, 240)}`);
      err.status = res.status;
      throw err;
    }
    return { data, status: res.status };
  }
  return {
    rest: {
      users: { getAuthenticated: () => request('GET', '/user') },
      repos: {
        get: ({ owner, repo }) => request('GET', `/repos/${owner}/${repo}`),
        createForAuthenticatedUser: (body) => request('POST', '/user/repos', body),
        createInOrg: ({ org, ...body }) => request('POST', `/orgs/${org}/repos`, body),
        update: ({ owner, repo, ...body }) => request('PATCH', `/repos/${owner}/${repo}`, body),
      },
    },
    request: ({ method = 'GET', url, data }) => request(method, url.replace(/^https:\/\/api\.github\.com/, ''), data),
  };
}

export function redactGitError(err) {
  return String(err?.message || err || '')
    .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/x-access-token:[^@\s]+/gi, 'x-access-token:***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}
