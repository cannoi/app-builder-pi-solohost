/**
 * Fetch pinned upstream source into templates/cache on demand.
 * Templates ship only SoloHost overlays + manifest; full trees are downloaded at instantiate.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function safeSegment(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

export function parseGithubFetch(fetchSpec = {}, source = {}) {
  const url = String(fetchSpec.url || source.url || '').trim();
  let owner = fetchSpec.owner || null;
  let repo = fetchSpec.repo || null;
  const ref = String(fetchSpec.ref || fetchSpec.tag || source.ref || 'main').replace(/^refs\/(tags|heads)\//, '');
  if ((!owner || !repo) && url) {
    const m = url.match(/github\.com[/:]([^/]+)\/([^/#?\s]+)/i);
    if (m) {
      owner = m[1];
      repo = m[2].replace(/\.git$/i, '');
    }
  }
  if (!owner || !repo) return null;
  return { owner, repo, ref: ref || 'main', url: `https://github.com/${owner}/${repo}` };
}

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Ensure upstream material is in cacheDir/<id>@<ref>/source
 * Returns absolute path to extracted source root.
 */
export async function ensureUpstreamMaterial({
  templatesDir,
  templateId,
  fetchSpec,
  source = {},
  timeoutMs = 120_000,
} = {}) {
  const gh = parseGithubFetch(fetchSpec, source);
  if (!gh) {
    const err = new Error('Template fetch requires GitHub owner/repo/ref');
    err.code = 'FETCH_SPEC_INVALID';
    throw err;
  }
  const root = path.resolve(templatesDir || './templates');
  const cacheRoot = path.join(root, 'cache', safeSegment(templateId), safeSegment(gh.ref));
  const marker = path.join(cacheRoot, 'READY.json');
  const sourceDir = path.join(cacheRoot, 'source');
  if (await pathExists(marker) && await pathExists(sourceDir)) {
    return { sourceDir, cacheRoot, fromCache: true, github: gh };
  }

  await fs.mkdir(cacheRoot, { recursive: true });
  const zipPath = path.join(cacheRoot, 'upstream.zip');
  const zipUrlTag = `https://codeload.github.com/${gh.owner}/${gh.repo}/zip/refs/tags/${encodeURIComponent(gh.ref)}`;
  const zipUrlHead = `https://codeload.github.com/${gh.owner}/${gh.repo}/zip/refs/heads/${encodeURIComponent(gh.ref)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(zipUrlTag, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AppBuilder-SoloHost-TemplateFetch/1.8.37' },
    });
    if (!res.ok) {
      res = await fetch(zipUrlHead, {
        signal: controller.signal,
        headers: { 'User-Agent': 'AppBuilder-SoloHost-TemplateFetch/1.8.37' },
      });
    }
    if (!res.ok) {
      const err = new Error(`Upstream download failed HTTP ${res.status} for ${gh.owner}/${gh.repo}@${gh.ref}`);
      err.code = 'FETCH_HTTP';
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(zipPath, buf);
  } finally {
    clearTimeout(timer);
  }

  // Extract with system unzip (available in Builder image)
  const extractRoot = path.join(cacheRoot, 'extract');
  await fs.rm(extractRoot, { recursive: true, force: true });
  await fs.mkdir(extractRoot, { recursive: true });
  try {
    await execFileAsync('unzip', ['-q', zipPath, '-d', extractRoot], { timeout: 60_000 });
  } catch (err) {
    const e = new Error(`Failed to unzip upstream: ${err.message}`);
    e.code = 'FETCH_UNZIP';
    throw e;
  }

  const entries = await fs.readdir(extractRoot, { withFileTypes: true });
  const top = entries.find((d) => d.isDirectory());
  await fs.rm(sourceDir, { recursive: true, force: true });
  if (top) {
    await fs.rename(path.join(extractRoot, top.name), sourceDir);
  } else {
    await fs.rename(extractRoot, sourceDir);
  }
  await fs.rm(extractRoot, { recursive: true, force: true }).catch(() => {});
  // strip noise
  for (const name of ['node_modules', '.git', 'coverage']) {
    await fs.rm(path.join(sourceDir, name), { recursive: true, force: true }).catch(() => {});
  }

  await fs.writeFile(marker, JSON.stringify({
    templateId,
    owner: gh.owner,
    repo: gh.repo,
    ref: gh.ref,
    retrievedAt: new Date().toISOString(),
    scriptsExecuted: false,
  }, null, 2) + '\n');

  return { sourceDir, cacheRoot, fromCache: false, github: gh };
}

export default { ensureUpstreamMaterial, parseGithubFetch };
