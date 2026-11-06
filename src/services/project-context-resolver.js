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

/** Context Engine v2 (partial): classify paths for budget preference */
export function classifyContextFile(relPath = '') {
  const n = String(relPath).replace(/\\/g, '/').toLowerCase();
  if (/package-lock\.json|yarn.lock|pnpm-lock|\.github\/workflows|node_modules\/|solohost\//.test(n)) return 'generated';
  if (/\.(md|txt)$/.test(n) || n.startsWith('docs/')) return 'docs';
  if (/(^|\/)(dockerfile|docker-compose|config_options|\.env)/.test(n) || /package\.json$/.test(n)) return 'config';
  if (/\.(js|mjs|cjs|ts|tsx|jsx|html|css|py|go|rs)$/.test(n)) return 'source';
  return 'data';
}

function contextClassPenalty(relPath) {
  const c = classifyContextFile(relPath);
  if (c === 'generated') return -800;
  if (c === 'docs') return -200;
  if (c === 'source') return 200;
  if (c === 'config') return 50;
  return 0;
}

// CONTEXT_V2
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
  const ranked = await rankFilesV2(sourceDir, allFiles, query, mode);
  const selected = ranked.slice(0, mode === 'improve' || mode === 'diagnose' ? 14 : mode === 'upgrade' ? 18 : 12);

  const chunks = [];
  chunks.push(formatSnapshotHeader(meta, mode, query));
  chunks.push(NEED_FILES_HINT);
  chunks.push(
    `--- FILE INVENTORY (${allFiles.length} paths, names only) ---\n`
    + `Use ONLY these paths when editing. Excerpts below are a small relevant subset — not the whole app.\n`
    + `Need another file body? Reply with [NEED_FILES: path1, path2] or {"need_files":["path1"]} and no other changes yet.\n`
    + allFiles.slice(0, 220).join('\n')
    + (allFiles.length > 220 ? `\n… +${allFiles.length - 220} more paths` : '')
  );

  let total = chunks.join('\n\n').length;
  const selectedFiles = [];
  const partialFiles = [];
  const terms = queryTerms(query);
  for (const rel of selected) {
    const remaining = maxChars - total - 60;
    if (remaining < 400) break;
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (!text) continue;
    const limit = Math.min(perFileLimit(rel, mode), remaining);
    // v2: never clip silently. Oversized code gets an outline + the windows that matter for the request,
    // with the omitted line ranges named so the AI can ask for them (NEED_FILES path:from-to).
    const rendered = text.length <= limit ? { body: text, partial: false } : renderWindowed(rel, text, limit, terms);
    const part = `--- ${rel} ---\n${rendered.body}`;
    chunks.push(part);
    selectedFiles.push(rel);
    if (rendered.partial) partialFiles.push(rel);
    total += part.length + 2;
  }
  if (partialFiles.length) chunks.push(`NOTE: ${partialFiles.join(', ')} ${partialFiles.length > 1 ? 'are' : 'is'} shown as outline + relevant windows. Request omitted ranges with [NEED_FILES: path:from-to] before editing code you cannot see.`);

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

const NEED_FILES_HINT = `CONTEXT POLICY (lean):
- The user request comes first. File excerpts are supporting evidence only.
- You receive a PATH inventory + a small set of relevant file bodies — not the whole app.
- Missing a file you must edit? Request it explicitly:
  [NEED_FILES: path/from/inventory.js, other.js:1-80]
  or JSON {"need_files":["path/from/inventory.js"]}
- Do not invent paths. Do not ask for node_modules or binaries.
- After receiving ADDITIONAL FILES, make the smallest safe change.`;

function defaultBudget(mode) {
  // Lean body budget: full app is NOT dumped. AI requests more via NEED_FILES.
  if (mode === 'upgrade') return 28000;
  if (mode === 'diagnose' || mode === 'improve') return 22000;
  if (mode === 'ask' || mode === 'chat') return 18000;
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

    if (CORE_MANIFESTS.includes(rel)) score += (mode === 'improve' || mode === 'upgrade') ? 200 : 1000;
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
    if (mode === 'improve' && /(^|\/)server\.(js|mjs|cjs)$/.test(rel)) score += 120;
    if ((mode === 'ask' || mode === 'chat') && /readme|config/i.test(rel)) score += 20;
    score += contextClassPenalty(rel);

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
  if (/package-lock\.json|yarn\.lock|pnpm-lock/i.test(rel)) return 1200;
  if (/\.github\/workflows/i.test(rel)) return 1800;
  if (/readme|install|\.md$/i.test(rel)) return 2400;
  if (/\.css$/i.test(rel)) return mode === 'upgrade' ? 5000 : 3500;
  if (/package\.json|Dockerfile|config_options|docker-compose/i.test(rel)) return 6000;
  if (mode === 'upgrade') return 16000;
  if (mode === 'ask' || mode === 'chat') return 6000;
  return 14000; // improve / diagnose: real source files up to ~14 K chars are sent whole
}


// ---------- Context Engine v2 helpers (1.8.9) ----------
const BACKEND_HINT = /\b(multiplayer|multi-player|network|socket|websocket|ws|lan|wifi|wi-fi|api|login|logout|auth|oauth|password|session|database|db|sql|sqlite|route|routes|server|backend|endpoint|room|rooms|lobby|cors|port|đăng nhập|đăng xuất|mật khẩu|cơ sở dữ liệu|máy chủ|mạng|nhiều người|phòng|kết nối)\b/iu;
const FRONTEND_HINT = /\b(button|screen|page|color|colour|layout|animation|style|theme|dark|light|font|icon|menu|form|input|responsive|mobile|ui|nút|màu|giao diện|hiệu ứng|chữ|biểu tượng|trang|màn hình|bố cục|chế độ tối)\b/iu;

function queryTerms(query) {
  const base = tokenize(query).filter((t) => !/^(the|and|for|with|that|this|from|into|add|make|app|please|want|need|can|you|tôi|cho|và|của|với|một|các|những|thêm|làm|giúp)$/i.test(t));
  return [...new Set(base)].slice(0, 16);
}

/** Async ranking: path/class signals + request semantics + keyword hits INSIDE the files (small projects only). */
async function rankFilesV2(sourceDir, allFiles, query, mode) {
  const base = rankFiles(allFiles, query, mode); // existing path-based order (kept as the stable backbone)
  const scoreMap = new Map(base.map((rel, i) => [rel, (base.length - i) * 4]));
  const terms = queryTerms(query);
  const wantsBackend = BACKEND_HINT.test(String(query || ''));
  const wantsFrontend = FRONTEND_HINT.test(String(query || ''));
  const candidates = allFiles.filter((rel) => CODE_RE.test(rel) && classifyContextFile(rel) !== 'generated').slice(0, 120);
  let read = 0;
  for (const rel of candidates) {
    let bonus = scoreMap.get(rel) || 0;
    const cls = classifyContextFile(rel);
    const isServer = /(^|\/)(server|app|index|routes?|api|socket|ws|db|database|gateway|proxy)[^/]*\.(js|mjs|cjs|ts)$/i.test(rel) && !/^public\//.test(rel);
    const isClient = /^public\//.test(rel) || /\.(html|css)$/i.test(rel);
    if (wantsBackend && isServer) bonus += 150;
    if (wantsFrontend && isClient) bonus += 120;
    if (terms.length && cls === 'source' && read < 60) {
      const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
      read += 1;
      if (text && text.length < 250000) {
        const low = text.toLowerCase();
        let hits = 0;
        for (const t of terms) { let i = 0; let c = 0; while (c < 6 && (i = low.indexOf(t, i)) !== -1) { c += 1; i += t.length; } hits += c; }
        bonus += Math.min(90, hits * 8);
      }
    }
    scoreMap.set(rel, bonus);
  }
  return [...scoreMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rel]) => rel);
}

const DECL_RE = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s*[A-Za-z0-9_$]+|class\s+[A-Za-z0-9_$]+|(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>)|^\s*(?:app|router|server)\.(?:get|post|put|delete|patch|use|ws|on)\s*\(|^\s*(?:<script|<style|<section\s|<main|<canvas|<form)|^\s*(?:def|class)\s+[A-Za-z0-9_]+/;

function outlineOf(lines) {
  const out = [];
  for (let i = 0; i < lines.length && out.length < 70; i++) {
    if (DECL_RE.test(lines[i])) out.push(`L${i + 1}: ${lines[i].trim().slice(0, 110)}`);
  }
  return out;
}

/** Outline + head + keyword windows within `limit` chars; omitted ranges are named explicitly. */
function renderWindowed(rel, text, limit, terms) {
  const lines = text.split('\n');
  const total = lines.length;
  const outline = outlineOf(lines);
  const header = `[${rel}: ${total} lines, ${text.length} chars — showing outline + relevant windows]`;
  const outlineBlock = outline.length ? `OUTLINE:\n${outline.join('\n')}\n` : '';
  let budget = limit - header.length - outlineBlock.length - 120;
  if (budget < 600) budget = Math.max(600, limit - header.length - 120);
  // windows: head, keyword hits (±10 lines), tail
  const keep = new Array(total).fill(false);
  const mark = (a, b) => { for (let i = Math.max(0, a); i <= Math.min(total - 1, b); i++) keep[i] = true; };
  mark(0, 24);
  const low = lines.map((l) => l.toLowerCase());
  const hitLines = [];
  for (let i = 0; i < total; i++) { if (terms.some((t) => low[i].includes(t))) hitLines.push(i); }
  // prefer declarations that contain a hit, then raw hits (spread through the file)
  const step = Math.max(1, Math.floor(hitLines.length / 12));
  for (let h = 0; h < hitLines.length; h += step) mark(hitLines[h] - 8, hitLines[h] + 12);
  mark(total - 12, total - 1);
  // render kept ranges until the budget is used
  const parts = [];
  let used = 0;
  let i = 0;
  while (i < total) {
    if (!keep[i]) {
      let j = i; while (j < total && !keep[j]) j++;
      parts.push(`/* … lines ${i + 1}-${j} omitted … */`);
      used += 40; i = j; continue;
    }
    let j = i; while (j < total && keep[j]) j++;
    const seg = lines.slice(i, j).map((l, k) => `${l}`).join('\n');
    if (used + seg.length > budget) {
      const room = Math.max(0, budget - used);
      parts.push(seg.slice(0, room) + `\n/* … lines ${i + 1}-${j} cut at the size limit … */`);
      used = budget;
      // name every remaining range as omitted
      if (j < total) parts.push(`/* … lines ${j + 1}-${total} omitted … */`);
      break;
    }
    parts.push(seg); used += seg.length; i = j;
  }
  return { body: `${header}\n${outlineBlock}${parts.join('\n')}`, partial: true };
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
