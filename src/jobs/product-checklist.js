/**
 * Product depth checklist (v1.8.12).
 * Blocks calling a build "done" when the app is only a name shell.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';

const SKIP = /(^|\/)(node_modules\/|\.git\/|artifacts\/|data\/)/;

async function readText(root, rel) {
  try {
    return await fs.readFile(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @returns {{ ok: boolean, score: number, issues: string[], summary: string, metrics: object }}
 */
export async function evaluateProductDepth(sourceDir, { name = '', idea = '' } = {}) {
  const issues = [];
  const files = (await listFiles(sourceDir).catch(() => [])).filter((f) => !SKIP.test(f));
  const set = new Set(files);
  const metrics = { files: files.length, htmlChars: 0, interactive: 0, routes: 0 };

  const hasPkg = set.has('package.json');
  const hasDocker = set.has('Dockerfile');
  if (!hasPkg) issues.push('missing_package_json');
  if (!hasDocker) issues.push('missing_dockerfile');

  const htmlCandidates = ['public/index.html', 'index.html', 'src/public/index.html', 'views/index.html'];
  let html = '';
  let htmlPath = '';
  for (const rel of htmlCandidates) {
    if (set.has(rel)) {
      html = await readText(sourceDir, rel);
      htmlPath = rel;
      break;
    }
  }
  // Also accept server that only serves inline HTML from js
  const serverCandidates = ['server.js', 'src/server.js', 'index.js', 'app.js', 'src/app.js'];
  let server = '';
  for (const rel of serverCandidates) {
    if (set.has(rel)) {
      server = await readText(sourceDir, rel);
      if (server.length > 80) break;
    }
  }

  const visible = stripTags(html);
  metrics.htmlChars = visible.length;
  const nameNorm = String(name || '').trim().toLowerCase();
  const visibleNorm = visible.toLowerCase();

  // Interactive affordances
  const blob = `${html}\n${server}`;
  if (/<form[\s>]/i.test(blob)) metrics.interactive += 1;
  if (/<button[\s>]/i.test(blob) || /type=["']submit["']/i.test(blob)) metrics.interactive += 1;
  if (/<input[\s>]/i.test(blob) || /<textarea[\s>]/i.test(blob) || /<select[\s>]/i.test(blob)) metrics.interactive += 1;
  if (/\bfetch\s*\(|XMLHttpRequest|axios\.|\/api\//i.test(blob)) metrics.interactive += 1;
  if (/app\.(get|post|put|delete)\s*\(/i.test(server) || /router\.(get|post)\s*\(/i.test(server)) {
    metrics.routes = (server.match(/\.(get|post|put|delete)\s*\(/gi) || []).length;
  }

  // "Name only" shell: short visible text that is mostly the app name / generic hello
  const genericOnly = /^(welcome|hello|my app|app builder|coming soon|todo)\b/i.test(visible)
    || (nameNorm && visibleNorm === nameNorm)
    || (nameNorm && visibleNorm.length > 0 && visibleNorm.replace(nameNorm, '').trim().length < 24);

  if (!html && metrics.routes < 2 && metrics.interactive < 1) {
    issues.push('no_ui_or_api_surface');
  }
  if (html && (visible.length < 40 || genericOnly) && metrics.interactive < 2) {
    issues.push('ui_name_shell');
  }
  if (files.length < 4) {
    issues.push('too_few_files');
  }
  if (metrics.interactive < 1 && metrics.routes < 2) {
    issues.push('no_user_action');
  }

  // Score 0–100
  let score = 0;
  if (hasPkg) score += 15;
  if (hasDocker) score += 15;
  if (files.length >= 6) score += 15;
  else if (files.length >= 4) score += 8;
  if (metrics.htmlChars >= 120) score += 20;
  else if (metrics.htmlChars >= 40) score += 10;
  if (metrics.interactive >= 2) score += 20;
  else if (metrics.interactive >= 1) score += 10;
  if (metrics.routes >= 3) score += 15;
  else if (metrics.routes >= 1) score += 8;

  const ok = score >= 45 && !issues.includes('ui_name_shell') && !issues.includes('no_ui_or_api_surface');

  const summary = ok
    ? `Product checklist passed (score ${score}/100).`
    : `Product checklist failed (score ${score}/100): app looks incomplete (${issues.join(', ') || 'thin shell'}).`;

  return {
    ok,
    score,
    issues,
    summary,
    metrics: { ...metrics, htmlPath, nameOnly: Boolean(genericOnly) },
  };
}

export function isLocalDefaults(meta) {
  return String(meta?.source || '') === 'local-defaults';
}

export function hasConfiguredAi(ai, cfg) {
  try {
    if (ai?.status) {
      const s = ai.status();
      if (s?.configured || s?.gemini || s?.deepseek) return true;
    }
  } catch { /* ignore */ }
  const c = cfg?.ai || {};
  return Boolean(c.geminiKey || c.deepseekKey || c.openaiKey || c.apiKey);
}
