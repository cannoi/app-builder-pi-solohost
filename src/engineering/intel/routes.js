/**
 * Route intelligence v2 (v1.10.0, D-04) — static, deterministic, bounded.
 *
 * Server strategies:
 *   (a) router calls     app.get('/x') · router.post('/x') · fastify.route({ url: '/x' }) · .use('/x')
 *   (b) manual matching  pathname === '/x' · req.url === '/x' · url.pathname.startsWith('/x') · switch(pathname){ case '/x': }
 *                        with nearby req.method checks
 *   (c) route tables     { 'GET /api/x': fn } · { '/api/x': fn } · routes = [{ path: '/x' }]
 * Client strategies (public/**, *.html):
 *   (d) fetch('/api/x') · axios.get('/x') · xhr.open('GET','/x') · <form action> · <a href> · <script src> · <link href> · <img src>
 * Cross-check: client API calls with no server route → WARNING broken_reference (the most common AI bug).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUS } from '../validation/status.js';

const MAX_FILES = 200;
const MAX_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'snapshots', 'artifacts', 'data', 'logs', '.next', 'vendor']);
const METHOD = '(get|post|put|patch|delete|del|all|head|options|use)';

async function readText(abs) {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return await fs.readFile(abs, 'utf8');
  } catch { return null; }
}

async function walk(root, rel, filter, out, depth = 0) {
  if (out.length >= MAX_FILES || depth > 8) return;
  let entries = [];
  try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_FILES) break;
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, r, filter, out, depth + 1);
    else if (filter(r)) out.push(r);
  }
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function normPath(p) {
  let s = String(p || '').trim();
  s = s.split('#')[0].split('?')[0];
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

function isServerish(rel, text) {
  if (/^public\//.test(rel) || /(^|\/)(tests?|__tests__|spec)\//.test(rel) || /\.(test|spec)\.[cm]?js$/.test(rel)) return false;
  return /createServer|express\(|fastify|koa|listen\s*\(|Router\(|\.(get|post)\s*\(|pathname|req\.url|request\.url/.test(text);
}

function nearbyMethod(text, index) {
  const start = Math.max(0, text.lastIndexOf('\n', Math.max(0, index - 1)) - 0);
  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(start, lineEnd < 0 ? undefined : lineEnd);
  const m = /method\s*===?\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i.exec(line)
    || /['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*===?\s*[\w.]*method/i.exec(line);
  if (m) return m[1].toUpperCase();
  // look ahead a few lines inside the block
  const after = text.slice(lineEnd < 0 ? text.length : lineEnd, (lineEnd < 0 ? text.length : lineEnd) + 240);
  const m2 = /^[^\n]*\n?[^\n]*\n?[^\n]*/.exec(after)?.[0].match(/method\s*(?:===?|!==?)\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
  return m2 ? m2[1].toUpperCase() : 'ANY';
}

export function extractServerRoutes(text, rel) {
  const routes = [];
  const add = (method, p, kind, index, strategy) => {
    if (!p || !p.startsWith('/') || p.startsWith('//')) return;
    routes.push({ method: String(method || 'ANY').toUpperCase().replace('DEL', 'DELETE').replace('DELETEETE', 'DELETE'), path: normPath(p), kind, file: rel, line: lineOf(text, index), strategy });
  };
  let m;
  // (a) router-style calls
  const reCall = new RegExp(`\\.${METHOD}\\s*\\(\\s*['"\`](\\/[^'"\`\\s]*)['"\`]`, 'gi');
  while ((m = reCall.exec(text))) {
    const meth = m[1].toLowerCase();
    add(meth === 'use' || meth === 'all' ? 'ANY' : meth, m[2], meth === 'use' ? 'prefix' : 'exact', m.index, 'router');
  }
  const reRoute = /\.route\s*\(\s*\{[^}]*?(?:url|path)\s*:\s*['"`](\/[^'"`]*)['"`][^}]*?\}/gi;
  while ((m = reRoute.exec(text))) {
    const meth = /method\s*:\s*['"`](\w+)['"`]/i.exec(m[0])?.[1] || 'ANY';
    add(meth, m[1], 'exact', m.index, 'router');
  }
  const reRouteChain = /\.route\s*\(\s*['"`](\/[^'"`]*)['"`]\s*\)\s*\.(get|post|put|patch|delete)/gi;
  while ((m = reRouteChain.exec(text))) add(m[2], m[1], 'exact', m.index, 'router');
  // (b) manual matching
  const reEq = /\b(?:[\w$]+\.)*(?:pathname|url|path|route|p|u)\s*===?\s*['"`](\/[^'"`]*)['"`]/g;
  while ((m = reEq.exec(text))) add(nearbyMethod(text, m.index), m[1], 'exact', m.index, 'pathname');
  const reEqRev = /['"`](\/[^'"`]*)['"`]\s*===?\s*(?:[\w$]+\.)*(?:pathname|url|path)\b/g;
  while ((m = reEqRev.exec(text))) add(nearbyMethod(text, m.index), m[1], 'exact', m.index, 'pathname');
  const reStarts = /\b(?:[\w$]+\.)*(?:pathname|url|path)\s*\.startsWith\s*\(\s*['"`](\/[^'"`]*)['"`]/g;
  while ((m = reStarts.exec(text))) add(nearbyMethod(text, m.index), m[1], 'prefix', m.index, 'pathname');
  const reMatchRe = /\b(?:[\w$]+\.)*(?:pathname|url)\s*\.match\s*\(\s*\/\^((?:\\\/|[A-Za-z0-9_-])+)/g;
  while ((m = reMatchRe.exec(text))) add(nearbyMethod(text, m.index), m[1].replace(/\\\//g, '/'), 'prefix', m.index, 'pathname');
  if (/switch\s*\(\s*(?:[\w$]+\.)*(?:pathname|url|path|route)\s*\)/.test(text)) {
    const reCase = /case\s+['"`](\/[^'"`]*)['"`]\s*:/g;
    while ((m = reCase.exec(text))) add('ANY', m[1], 'exact', m.index, 'switch');
  }
  // (c) route tables
  const reTable = /['"`]((?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+)?(\/[A-Za-z0-9_\-/:.]*)['"`]\s*:\s*(?:async\s*)?(?:\(|function|[A-Za-z_$])/g;
  while ((m = reTable.exec(text))) add(m[1] ? m[1].trim() : 'ANY', m[2], 'exact', m.index, 'table');
  const reObj = /\{\s*(?:method\s*:\s*['"`](\w+)['"`]\s*,\s*)?path\s*:\s*['"`](\/[^'"`]*)['"`]/g;
  while ((m = reObj.exec(text))) add(m[1] || 'ANY', m[2], 'exact', m.index, 'table');
  return routes;
}

function stringConsts(text) {
  const map = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`](\/[^'"`$]*)['"`]/g;
  let m;
  while ((m = re.exec(text))) map.set(m[1], m[2]);
  return map;
}

/** URL directory an HTML file is served from: public/index.html → '/', public/a/b.html → '/a/', index.html → '/'. */
export function pageBaseFor(rel) {
  if (!/\.html?$/i.test(rel)) return null;
  const inPublic = rel.startsWith('public/') ? rel.slice('public/'.length) : rel;
  const dir = path.posix.dirname(inPublic);
  return dir === '.' ? '/' : `/${dir}/`;
}

export function extractClientRefs(text, rel) {
  const refs = [];
  const consts = stringConsts(text);
  const base = pageBaseFor(rel);
  const add = (kind, raw, method, index, dynamic = false) => {
    if (raw == null) return;
    let p = String(raw).trim();
    if (!p || /^(https?:)?\/\//i.test(p) || /^(mailto:|tel:|javascript:|data:|#|blob:)/i.test(p)) return;
    if (!p.startsWith('/')) {
      // Relative ASSET refs in an HTML page resolve against the page URL (e.g. "public/x.png" on "/" → "/public/x.png").
      // Other relative refs (links, JS-built URLs) are not checked — the base is not knowable statically.
      if (kind !== 'asset' || !base || /[`$]/.test(p)) return;
      p = path.posix.normalize(base + p.replace(/[?#].*$/, ''));
      if (p.startsWith('..')) return;
    }
    refs.push({ kind, path: normPath(p), method: (method || 'GET').toUpperCase(), file: rel, line: lineOf(text, index), dynamic });
  };
  let m;
  const reFetch = /\bfetch\s*\(\s*(?:(['"])(\/[^'"]*)\1|`(\/[^`$]*)(\$\{)?[^`]*`|([A-Za-z_$][\w$]*))\s*(,\s*\{[^)]*?method\s*:\s*['"`](\w+)['"`])?/g;
  while ((m = reFetch.exec(text))) {
    const method = m[7] || 'GET';
    if (m[2]) add('api', m[2], method, m.index);
    else if (m[3] != null) add('api', m[3], method, m.index, Boolean(m[4]));
    else if (m[5] && consts.has(m[5])) add('api', consts.get(m[5]), method, m.index);
  }
  const reAxios = /\baxios\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`$]*)(\$\{)?/g;
  while ((m = reAxios.exec(text))) add('api', m[2], m[1], m.index, Boolean(m[3]));
  const reXhr = /\.open\s*\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*['"`](\/[^'"`$]*)(\$\{)?/gi;
  while ((m = reXhr.exec(text))) add('api', m[2], m[1], m.index, Boolean(m[3]));
  if (/\.html?$/i.test(rel) || /<form|<a\s|<script|<link/i.test(text)) {
    const reForm = /<form\b[^>]*\baction\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
    while ((m = reForm.exec(text))) add('form', m[1], /method\s*=\s*['"]?post/i.test(m[0]) ? 'POST' : 'GET', m.index);
    const reA = /<a\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"]/gi;
    while ((m = reA.exec(text))) add('link', m[1], 'GET', m.index);
    const reAsset = /<(?:script|img|source|audio|video)\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]|<link\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"]/gi;
    while ((m = reAsset.exec(text))) add('asset', m[1] || m[2], 'GET', m.index);
  }
  return refs;
}

function routeMatches(route, p) {
  if (route.kind === 'prefix') return p === normPath(route.path) || p.startsWith(route.path.endsWith('/') ? route.path : `${route.path}/`) || p.startsWith(route.path);
  if (route.path.includes(':') || route.path.includes('*')) {
    const re = new RegExp(`^${route.path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg === '*' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
    return re.test(p);
  }
  return normPath(route.path) === p;
}

function clientRefMatched(ref, serverRoutes, publicFiles) {
  const p = ref.path;
  if (ref.dynamic) {
    // template literal: we only know a prefix, so any route starting with it (or a param route) counts
    return serverRoutes.some((r) => r.path.startsWith(p.replace(/\/$/, '')) || routeMatches(r, `${p.replace(/\/$/, '')}/x`));
  }
  if (serverRoutes.some((r) => routeMatches(r, p) && (r.method === 'ANY' || ref.method === 'GET' && r.method === 'HEAD' || r.method === ref.method || ref.kind !== 'api'))) return true;
  const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
  if (publicFiles.has(rel) || publicFiles.has(`${rel}/index.html`) || publicFiles.has(`${rel}.html`)) return true;
  return false;
}

async function entryImports(sourceDir, entry, seen = new Set(), depth = 0) {
  if (!entry || depth > 4 || seen.has(entry) || seen.size > 60) return seen;
  seen.add(entry);
  const text = await readText(path.join(sourceDir, entry));
  if (!text) return seen;
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    let target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1]));
    if (target.startsWith('..')) continue;
    if (!/\.[cm]?js$/.test(target)) {
      for (const ext of ['.js', '.mjs', '.cjs', '/index.js']) {
        try { await fs.access(path.join(sourceDir, target + ext)); target += ext; break; } catch { /* */ }
      }
    }
    await entryImports(sourceDir, target, seen, depth + 1);
  }
  return seen;
}

export async function inspectRoutes(sourceDir) {
  if (!sourceDir) return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no sourceDir' };
  const serverCandidates = [];
  await walk(sourceDir, 'src', (r) => /\.[cm]?js$/.test(r), serverCandidates);
  for (const f of ['server.js', 'index.js', 'app.js', 'main.js', 'server.mjs', 'index.mjs', 'server.cjs', 'api.js', 'routes.js']) serverCandidates.push(f);
  for (const d of ['routes', 'api', 'lib', 'server']) await walk(sourceDir, d, (r) => /\.[cm]?js$/.test(r), serverCandidates);
  let pkg = null;
  try { pkg = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8')); } catch { /* */ }
  const startEntry = /node\s+([\w./-]+\.[cm]?js)/.exec(pkg?.scripts?.start || '')?.[1] || pkg?.main || null;
  if (startEntry) for (const f of await entryImports(sourceDir, startEntry.replace(/^\.\//, ''))) serverCandidates.push(f);

  const serverRoutes = [];
  const scannedFiles = [];
  for (const rel of [...new Set(serverCandidates)].slice(0, MAX_FILES)) {
    const text = await readText(path.join(sourceDir, rel));
    if (!text || !isServerish(rel, text)) continue;
    scannedFiles.push(rel);
    serverRoutes.push(...extractServerRoutes(text, rel));
  }
  // dedupe
  const seen = new Set();
  const uniqServer = serverRoutes.filter((r) => { const k = `${r.method} ${r.path} ${r.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const clientFiles = [];
  await walk(sourceDir, 'public', (r) => /\.(html?|js|mjs)$/i.test(r), clientFiles);
  await walk(sourceDir, 'static', (r) => /\.(html?|js|mjs)$/i.test(r), clientFiles);
  for (const f of ['index.html']) clientFiles.push(f);
  const publicAll = [];
  await walk(sourceDir, 'public', () => true, publicAll);
  const publicFiles = new Set(publicAll.map((f) => f.replace(/^public\//, '')));
  try { await fs.access(path.join(sourceDir, 'index.html')); publicFiles.add('index.html'); } catch { /* */ }

  const clientCalls = [];
  for (const rel of [...new Set(clientFiles)]) {
    const text = await readText(path.join(sourceDir, rel));
    if (!text) continue;
    clientCalls.push(...extractClientRefs(text, rel));
  }
  const unmatched = [];
  const missingAssets = [];
  const hasServer = scannedFiles.length > 0;
  for (const ref of clientCalls) {
    if (clientRefMatched(ref, uniqServer, publicFiles)) continue;
    if (ref.kind === 'api' || ref.kind === 'form') { if (hasServer) unmatched.push(ref); }
    else if (ref.kind === 'asset') missingAssets.push(ref);
    else if (ref.kind === 'link' && hasServer && !/\.\w{2,5}$/.test(ref.path)) {
      // page links: only flag when the server clearly has no catch-all static/SPA fallback
      unmatched.push(ref);
    }
  }
  const dedupeRefs = (list) => { const s = new Set(); return list.filter((r) => { const k = `${r.method} ${r.path}`; if (s.has(k)) return false; s.add(k); return true; }); };
  const unmatchedClientCalls = dedupeRefs(unmatched).slice(0, 40);
  const routes = [...new Set(uniqServer.map((r) => r.path))].slice(0, 120);
  const findings = [
    ...unmatchedClientCalls.map((r) => ({ type: 'broken_reference', severity: 'warning', message: `${r.method} ${r.path} is called by ${r.file}:${r.line} but no server route handles it`, file: r.file, line: r.line, path: r.path, method: r.method })),
    ...dedupeRefs(missingAssets).slice(0, 20).map((r) => ({ type: 'missing_asset', severity: 'warning', message: `${r.path} is referenced by ${r.file}:${r.line} but no file or route provides it`, file: r.file, line: r.line, path: r.path })),
  ];
  let status = STATUS.PASS;
  if (findings.length) status = STATUS.WARNING;
  else if (hasServer && !routes.length) status = STATUS.WARNING;
  else if (!hasServer && !clientCalls.length) status = STATUS.NOT_AVAILABLE;
  return {
    ok: true,
    status,
    data: {
      routes,
      serverRoutes: uniqServer.slice(0, 120),
      clientCalls: dedupeRefs(clientCalls).slice(0, 120),
      unmatchedClientCalls,
      missingAssets: dedupeRefs(missingAssets).slice(0, 20),
      findings,
      scannedFiles: scannedFiles.slice(0, 60),
      hasHealth: uniqServer.some((r) => /^\/(api\/)?(health|healthz|ready|live)$/.test(r.path)),
    },
    error: findings.length ? findings.map((f) => f.message).slice(0, 3).join('; ')
      : (status === STATUS.WARNING ? 'a server was found but no route paths could be extracted statically' : undefined),
  };
}
