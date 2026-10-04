/**
 * Unified AI project context resolver.
 * Single source of truth for Ask / Improve / Upgrade / Chat / Diagnose.
 * Does not invent code — only packages authoritative local (or imported) source.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';
import { sha256 } from '../utils/hash.js';
import { clampText } from '../utils/validate.js';

const DEFAULT_MAX_CHARS = 32000;
const HARD_MAX_CHARS = 64000;

const CORE_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'Dockerfile',
  'docker-compose.yml',
  'config_options.yml',
  '.github/workflows/docker.yml',
  'README.md',
  'INSTALL.md',
  'solohost/config.yml',
  'solohost/README.md',
];

const CORE_ENTRY = [
  'src/server.js',
  'server.js',
  'app.js',
  'src/app.js',
  'index.js',
  'src/index.js',
  'src/proxy.js',
  'src/gateway.js',
  'src/routes.js',
  'src/api/routes.js',
  'public/index.html',
  'public/app.js',
  'public/game.js',
  'public/browser.js',
  'public/style.css',
  'public/styles.css',
];

const SKIP_RE = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor)(\/|$)/i;
const CODE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|html|css|json|yml|yaml|md|txt|env\.example)$/i;

/**
 * @param {object} project - project record (optional if sourceDir provided)
 * @param {object} options
 * @param {'ask'|'improve'|'upgrade'|'chat'|'diagnose'} [options.mode]
 * @param {string} [options.query]
 * @param {number} [options.maxChars]
 * @param {string} [options.sourceDir] - absolute path to project source
 * @param {object} [options.meta] - extra metadata (sourceType, commitSha, sourceHash, githubUrl)
 * @returns {Promise<{ text: string, snapshot: object, selectedFiles: string[], needFilesHint: string }>}
 */
export async function buildAiProjectContext(project, options = {}) {
  const mode = String(options.mode || 'chat').toLowerCase();
  const query = String(options.query || '').trim();
  const maxChars = Math.min(HARD_MAX_CHARS, Math.max(4000, Number(options.maxChars) || defaultBudget(mode)));
  const sourceDir = options.sourceDir
    || (project?.sourceDir)
    || null;

  if (!sourceDir) {
    return {
      text: 'AUTHORITATIVE SOURCE SNAPSHOT\nsourceType: unknown\nfileCount: 0\n(no source directory available)\n',
      snapshot: emptySnapshot(),
      selectedFiles: [],
      needFilesHint: NEED_FILES_HINT,
    };
  }

  const allFiles = (await listFiles(sourceDir).catch(() => []))
    .map((f) => String(f).replace(/\\/g, '/'))
    .filter((f) => !SKIP_RE.test(f));

  const meta = await resolveSourceMeta(sourceDir, allFiles, options.meta || project || {});
  const ranked = rankFiles(allFiles, query, mode);
  const selected = pickWithinBudget(ranked, maxChars);

  const chunks = [];
  chunks.push(formatSnapshotHeader(meta, mode, query));
  chunks.push(NEED_FILES_HINT);
  chunks.push(`--- FILE INVENTORY (${allFiles.length}) ---\n${allFiles.slice(0, 160).join('\n')}${allFiles.length > 160 ? `\n… +${allFiles.length - 160} more` : ''}`);

  let total = chunks.join('\n\n').length;
  const selectedFiles = [];
  for (const rel of selected) {
    if (total >= maxChars - 800) break;
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (!text) continue;
    const limit = perFileLimit(rel, mode);
    const part = `--- ${rel} ---\n${clampText(text, limit)}`;
    if (total + part.length > maxChars) {
      const room = maxChars - total - 40;
      if (room < 200) break;
      chunks.push(`--- ${rel} ---\n${clampText(text, room)}`);
      selectedFiles.push(rel);
      break;
    }
    chunks.push(part);
    selectedFiles.push(rel);
    total += part.length;
  }

  const body = clampText(chunks.join('\n\n'), maxChars);
  return {
    text: body,
    snapshot: { ...meta, selectedFiles, mode, query: query.slice(0, 200) },
    selectedFiles,
    needFilesHint: NEED_FILES_HINT,
  };
}

/** Convenience: return only the text block (drop-in for collectProjectContext). */
export async function collectProjectContextText(sourceDir, query = '', mode = 'improve', maxChars) {
  const r = await buildAiProjectContext(null, { sourceDir, query, mode, maxChars });
  return r.text;
}

const NEED_FILES_HINT = `--- READ-ON-DEMAND ---
If a required source file is missing from this snapshot, respond with a structured request on its own line:
[NEED_FILES: path/to/file1, path/to/file2]
Do not invent file contents. Only request paths that appear in FILE INVENTORY or are strongly implied by the user request.`;

function defaultBudget(mode) {
  if (mode === 'upgrade') return 48000;
  if (mode === 'diagnose' || mode === 'improve') return 36000;
  if (mode === 'ask' || mode === 'chat') return 28000;
  return DEFAULT_MAX_CHARS;
}

function emptySnapshot() {
  return {
    sourceType: 'unknown',
    commitSha: null,
    sourceHash: null,
    fileCount: 0,
    timestamp: new Date().toISOString(),
  };
}

async function resolveSourceMeta(sourceDir, allFiles, meta = {}) {
  const sourceType = meta.sourceType
    || (meta.githubUrl || meta.repoUrl || meta.cloneUrl ? 'github' : 'local');
  let sourceHash = meta.sourceHash || null;
  if (!sourceHash && allFiles.length) {
    // Lightweight inventory hash (paths + sizes), not full content — fast & stable enough for context identity
    const sample = allFiles.slice(0, 200).join('\n');
    sourceHash = sha256(sample).slice(0, 16);
  }
  return {
    sourceType,
    commitSha: meta.commitSha || meta.commit || meta.ref || null,
    sourceHash,
    fileCount: allFiles.length,
    timestamp: new Date().toISOString(),
    githubUrl: meta.githubUrl || meta.repoUrl || null,
    branch: meta.branch || meta.defaultBranch || null,
  };
}

function formatSnapshotHeader(meta, mode, query) {
  const lines = [
    'AUTHORITATIVE SOURCE SNAPSHOT',
    `sourceType: ${meta.sourceType || 'local'}`,
    `commitSha: ${meta.commitSha || '—'}`,
    `sourceHash: ${meta.sourceHash || '—'}`,
    `fileCount: ${meta.fileCount ?? 0}`,
    `timestamp: ${meta.timestamp}`,
    `mode: ${mode}`,
  ];
  if (meta.githubUrl) lines.push(`githubUrl: ${meta.githubUrl}`);
  if (meta.branch) lines.push(`branch: ${meta.branch}`);
  if (query) lines.push(`query: ${query.slice(0, 180)}`);
  lines.push('This snapshot is the authoritative local working copy the Builder is operating on.');
  return lines.join('\n');
}

function rankFiles(allFiles, query, mode) {
  const keywords = tokenize(query);
  const scored = [];

  for (const rel of allFiles) {
    if (!CODE_RE.test(rel) && !CORE_MANIFESTS.includes(rel)) continue;
    let score = 0;
    const lower = rel.toLowerCase();

    if (CORE_MANIFESTS.includes(rel)) score += 1000;
    if (CORE_ENTRY.includes(rel)) score += 800;
    if (/^src\//.test(rel)) score += 40;
    if (/^public\//.test(rel)) score += 30;
    if (/\.(js|mjs|ts|tsx)$/.test(rel)) score += 20;
    if (/test|spec/i.test(rel)) score += mode === 'diagnose' ? 25 : 5;
    if (/readme|install/i.test(rel)) score += mode === 'ask' || mode === 'chat' ? 50 : 10;

    for (const k of keywords) {
      if (lower.includes(k)) score += 60;
      // path segment match
      const base = path.basename(lower);
      if (base.includes(k)) score += 40;
    }

    // Mode biases
    if (mode === 'upgrade' && /docker|solohost|workflow|package\.json/i.test(rel)) score += 50;
    if (mode === 'improve' && /server|route|app|public/i.test(rel)) score += 30;
    if ((mode === 'ask' || mode === 'chat') && /readme|config/i.test(rel)) score += 20;

    if (score > 0 || CORE_MANIFESTS.includes(rel) || CORE_ENTRY.includes(rel)) {
      scored.push({ rel, score });
    }
  }

  // Always ensure manifests + entries that exist are included even with score 0 path
  for (const rel of [...CORE_MANIFESTS, ...CORE_ENTRY]) {
    if (allFiles.includes(rel) && !scored.some((s) => s.rel === rel)) {
      scored.push({ rel, score: CORE_MANIFESTS.includes(rel) ? 1000 : 800 });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  // Cap candidate list
  return scored.slice(0, 80).map((s) => s.rel);
}

function pickWithinBudget(ranked, maxChars) {
  // Rough pre-filter: assume ~3k chars average per file for ordering only
  const out = [];
  let estimate = 2000; // header + inventory
  for (const rel of ranked) {
    if (out.length >= 48) break;
    const est = CORE_MANIFESTS.includes(rel) ? 2500 : 3500;
    if (estimate + est > maxChars && out.length >= 8) break;
    out.push(rel);
    estimate += est;
  }
  return out;
}

function perFileLimit(rel, mode) {
  if (/readme|install|\.md$/i.test(rel)) return 2400;
  if (/\.css$/i.test(rel)) return 2000;
  if (/package\.json|Dockerfile|config_options|docker-compose/i.test(rel)) return 6000;
  if (mode === 'upgrade') return 8000;
  if (mode === 'ask' || mode === 'chat') return 4500;
  return 5200;
}

function tokenize(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/i)
    .filter((x) => x.length > 2)
    .slice(0, 24);
}

/**
 * Optional helper: detect if stored GitHub source metadata is newer than local snapshot.
 * Returns { needsRefresh, reason, remote, local } — does not perform network I/O itself
 * unless a fetchFn is provided.
 */
export async function checkSourceFreshness({ localMeta = {}, remoteMeta = {}, fetchFn = null } = {}) {
  const localSha = localMeta.commitSha || localMeta.commit || null;
  const remoteSha = remoteMeta.commitSha || remoteMeta.commit || null;
  if (!localSha || !remoteSha) {
    return { needsRefresh: false, reason: 'insufficient_sha', local: localSha, remote: remoteSha };
  }
  if (localSha === remoteSha) {
    return { needsRefresh: false, reason: 'in_sync', local: localSha, remote: remoteSha };
  }
  if (typeof fetchFn === 'function') {
    try {
      const remote = await fetchFn();
      return checkSourceFreshness({ localMeta, remoteMeta: remote || remoteMeta });
    } catch {
      return { needsRefresh: true, reason: 'remote_check_failed', local: localSha, remote: remoteSha };
    }
  }
  return { needsRefresh: true, reason: 'sha_mismatch', local: localSha, remote: remoteSha };
}
