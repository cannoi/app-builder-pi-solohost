import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { PREVIEW_MIME as MIME } from './preview-mime.js';

export function createPreviewHandler({ projects }) {
  return async function preview(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const slug = parts[1];
    if (!slug) {
      safeHtml(res, 404, page('Missing app', 'This preview link is incomplete.', null));
      return true;
    }
    const project = projects.get(slug) || projects.list().find((p) => p.slug === slug);
    if (!project) {
      safeHtml(res, 404, page('App not found', 'This preview link does not match a Builder project.', null));
      return true;
    }
    const restParts = parts.slice(2);
    const isChrome = restParts.length === 0 || (restParts.length === 1 && restParts[0] === '');
    if (isChrome && req.method === 'GET') {
      safeHtml(res, 200, chromePage(project));
      return true;
    }
    const runtime = await projects.readMetadata(project, 'runtime.json', {}).catch(() => ({}));
    const target = resolvePreviewUpstream(runtime);
    const rel = '/' + restParts.filter((p) => p !== '__app__').join('/');
    const targetPath = (rel === '/' ? '/' : rel) + url.search;

    // Some browser-style apps turn an entered absolute URL into a relative
    // preview path such as /https://example.com. Do not proxy that URL through
    // the Builder (which would be an SSRF risk). Instead, safely hand the
    // browser back the external http(s) URL so the WebView navigates directly.
    // Read directly from the original pathname because splitting on '/' would
    // destroy the 'https://' delimiter.
    const appMarker = `/preview/${encodeURIComponent(project.slug)}/__app__/`;
    const rawAppPath = url.pathname.startsWith(appMarker) ? url.pathname.slice(appMarker.length) : '';
    const external = decodePreviewExternalUrl(rawAppPath ? `/${rawAppPath}` : targetPath);
    if (external) {
      const proxiedExternal = await proxyExternal(req, res, external, project);
      if (proxiedExternal) return true;
      // If the safe preview gateway cannot reach the public URL, keep the
      // failure inside Preview instead of silently turning it into a Builder 404.
      safeHtml(res, 502, page('External page unavailable', `The preview Internet gateway could not load <code>${escapeHtml(external)}</code>. The Sandbox itself may still have Internet; this is an external-page/proxy failure.`, project));
      return true;
    }
    if (url.pathname.startsWith(`/preview/${encodeURIComponent(project.slug)}/__web__`)) {
      const requested = String(url.searchParams.get('url') || '');
      const safeExternal = validateExternalUrl(requested);
      if (!safeExternal) {
        res.statusCode = 400; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: 'Only public http/https URLs are allowed.' }));
        return true;
      }
      const proxiedExternal = await proxyExternal(req, res, safeExternal, project);
      if (proxiedExternal) return true;
      res.statusCode = 502; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: 'External page could not be loaded by the safe preview gateway.' }));
      return true;
    }

    const apiPort = Number(runtime.apiPort);
    const isApi = /^\/(api|health|ready|live)(\/|$)/.test(rel === '/' ? '/' : rel);
    if (runtime.status === 'passed' && isApi && Number.isFinite(apiPort) && apiPort > 0) {
      const proxied = await proxy(req, res, runtime.apiHost || '127.0.0.1', apiPort, targetPath, project);
      if (proxied.ok) return true;
    }
    if (runtime.status === 'passed' && target && !isApi) {
      const proxied = await proxy(req, res, target.host, target.port, targetPath, project);
      if (proxied.ok && proxied.status < 400) return true;
    }
    const sourceDir = projects.sourceDir(project.slug);
    if (serveProjectFile(sourceDir, targetPath, res, project.slug)) return true;
    safeHtml(res, 503, page('App is not running', 'Go back to chat and tap ▶ Run. When it finishes, open this link again.', project));
    return true;
  };
}

function chromePage(project) {
  const home = builderHome(project);
  const frame = `/preview/${encodeURIComponent(project.slug)}/__app__/`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title>
<style>
html,body{margin:0;height:100%;background:#0e1116;color:#e8eef6;font:600 13px system-ui,sans-serif}
#bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:8px 12px;background:#0e1116;border-bottom:1px solid #293241}
#bar a{color:#8b7cff;text-decoration:none;font-weight:700}
iframe{position:fixed;top:38px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 38px);border:0;background:#fff}
</style></head><body>
<div id="bar"><a href="${home}">← Back to Builder</a><span style="opacity:.55">Test preview</span></div>
<iframe id="app" src="${frame}" title="App preview"></iframe>
<script>
(function(){
  var home = ${JSON.stringify(home)};
  var frame = document.getElementById('app');
  var loaded = false;
  frame.addEventListener('load', function(){ loaded = true; });
  setTimeout(function(){
    try {
      if (!loaded) { window.location.replace(home); return; }
      var doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      var text = (doc.body.innerText || '').trim();
      var visual = doc.body.querySelector('img,canvas,svg,video,input,button,canvas');
      if (text.length < 2 && !visual) window.location.replace(home);
    } catch (e) {}
  }, 5000);
})();
</script>
</body></html>`;
}


const EXTERNAL_MAX_BYTES = 8 * 1024 * 1024;
const EXTERNAL_TIMEOUT_MS = 10000;
const EXTERNAL_MAX_REDIRECTS = 5;

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function validateExternalUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

async function assertPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || net.isIP(host) && isPrivateIp(host)) throw new Error('Private network address blocked');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) throw new Error('Private network address blocked');
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a,b,c] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0 || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:') || x.startsWith('ff');
  }
  return true;
}

function externalAssetUrl(value, baseUrl, slug) {
  try {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('#') || /^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(raw)) return raw;
    const u = new URL(raw, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    return `/preview/${encodeURIComponent(slug)}/__web__?url=${encodeURIComponent(u.href)}`;
  } catch { return value; }
}

function rewriteExternalHtml(html, baseUrl, slug) {
  let out = String(html || '');
  out = out.replace(/\b(href|src|poster|action)=(['"])(.*?)\2/gi, (m, attr, q, value) => `${attr}=${q}${externalAssetUrl(value, baseUrl, slug)}${q}`);
  out = out.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, value) => `url(${q}${externalAssetUrl(value, baseUrl, slug)}${q})`);
  out = out.replace(/<base\b[^>]*>/gi, '');
  return out;
}

async function proxyExternal(req, res, externalUrl, project, redirects = 0) {
  const safe = validateExternalUrl(externalUrl);
  if (!safe || redirects > EXTERNAL_MAX_REDIRECTS) return false;
  const u = new URL(safe);
  try { await assertPublicHost(u.hostname); } catch { return false; }
  const transport = u.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return await new Promise((resolve) => {
    const client = transport.default || transport;
    const request = client.get(u, { headers: { 'user-agent': 'Pi-App-Factory-Sandbox/1.4', accept: req.headers.accept || '*/*' }, timeout: EXTERNAL_TIMEOUT_MS }, (up) => {
      const status = up.statusCode || 502;
      const location = up.headers.location;
      if (status >= 300 && status < 400 && location) {
        up.resume();
        proxyExternal(req, res, new URL(location, u).href, project, redirects + 1).then(resolve);
        return;
      }
      let bytes = 0; const chunks = [];
      up.on('data', (c) => { bytes += c.length; if (bytes <= EXTERNAL_MAX_BYTES) chunks.push(c); else request.destroy(); });
      up.on('end', () => {
        if (bytes > EXTERNAL_MAX_BYTES || status >= 400) { resolve(false); return; }
        const headers = { ...up.headers };
        for (const k of ['content-length','content-encoding','x-frame-options','content-security-policy','set-cookie']) delete headers[k];
        const type = String(headers['content-type'] || '');
        let body = Buffer.concat(chunks);
        if (type.includes('text/html')) body = Buffer.from(rewriteExternalHtml(body.toString('utf8'), u.href, project.slug), 'utf8');
        res.writeHead(status, { ...headers, 'cache-control': 'no-store' }); res.end(body); resolve(true);
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

export function decodePreviewExternalUrl(targetPath) {
  const raw = String(targetPath || '');
  const match = raw.match(/^\/(https?:\/\/[^\s]+)$/i);
  if (!match) return null;
  try {
    const u = new URL(match[1]);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

export function previewAssetPrefix(slug) {
  return `/preview/${encodeURIComponent(slug)}/__app__`;
}

export function rewriteRootAssetUrls(html, slug) {
  const prefix = previewAssetPrefix(slug);
  return String(html || '')
    .replace(/\s(href|src|poster|action)=(["'])\/(?!\/|preview\/|\?)/gi, ` $1=$2${prefix}/`)
    .replace(/url\(\s*(['"]?)\/(?!\/|preview\/)/gi, `url($1${prefix}/`);
}

export function injectPreviewBridge(html, slug) {
  const prefix = previewAssetPrefix(slug);
  const snippet = `<base href="${prefix}/"><script data-paf-bridge="1">(function(){var p=${JSON.stringify(prefix)};function fix(u){if(typeof u!=='string')return u;if(!u||u.charAt(0)!=='/')return u;if(u.indexOf(p)===0||u.indexOf('/preview/')===0||u.indexOf('/?')===0)return u;return p+u;}var f=window.fetch;window.fetch=function(i,n){if(typeof i==='string')i=fix(i);else if(i&&i.url)i=new Request(fix(i.url),i);return f.call(this,i,n);};var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string')arguments[1]=fix(u);return o.apply(this,arguments);};})();</script>`;
  let text = rewriteRootAssetUrls(String(html || ''), slug);
  if (/data-paf-bridge/.test(text)) return text;
  if (/<head[^>]*>/i.test(text)) return text.replace(/<head[^>]*>/i, (m) => `${m}${snippet}`);
  return `${snippet}${text}`;
}

export function findProjectAsset(sourceDir, targetPath) {
  const clean = decodeURIComponent(String(targetPath || '/').split('?')[0] || '/');
  const rel = (clean === '/' ? 'index.html' : clean.replace(/^\/+/, '')).replace(/\\/g, '/');
  const roots = ['public', 'dist', 'www', 'static', 'assets', ''];
  for (const dir of roots) {
    const root = path.resolve(sourceDir, dir);
    const file = path.normalize(path.join(root, rel));
    if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  const wanted = rel.toLowerCase();
  const stack = [sourceDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        stack.push(full);
      } else {
        const relFound = path.relative(sourceDir, full).replace(/\\/g, '/');
        if (relFound === rel || relFound.toLowerCase() === wanted || relFound.endsWith(`/${rel}`) || relFound.endsWith(`/${path.basename(rel)}`)) {
          if (path.basename(relFound).toLowerCase() === path.basename(rel).toLowerCase()) return full;
        }
      }
    }
  }
  return null;
}

function serveProjectFile(sourceDir, targetPath, res, slug) {
  const candidate = findProjectAsset(sourceDir, targetPath);
  if (!candidate) return false;
  try {
    let data = fs.readFileSync(candidate);
    const type = MIME[path.extname(candidate).toLowerCase()] || 'application/octet-stream';
    if (type.includes('text/html') && slug) data = Buffer.from(injectPreviewBridge(data.toString('utf8'), slug), 'utf8');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function proxy(req, res, hostname, port, targetPath, project) {
  return new Promise((resolve) => {
    const headers = { host: `${hostname}:${port}` };
    for (const [k, v] of Object.entries(req.headers || {})) {
      const key = k.toLowerCase();
      if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'content-length'].includes(key)) continue;
      headers[k] = v;
    }
    const incoming = http.request({
      hostname,
      port,
      path: targetPath || '/',
      method: req.method,
      headers,
      timeout: 5000,
    }, (up) => {
      const status = up.statusCode || 502;
      const hop = { ...up.headers };
      delete hop.connection;
      delete hop['keep-alive'];
      delete hop['x-frame-options'];
      delete hop['content-security-policy'];
      if (status >= 400) {
        up.resume();
        resolve({ ok: false, status });
        return;
      }
      const ctype = String(hop['content-type'] || hop['Content-Type'] || '');
      const slug = project?.slug;
      if (slug && ctype.includes('text/html')) {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          try {
            const html = injectPreviewBridge(Buffer.concat(chunks).toString('utf8'), slug);
            delete hop['content-length'];
            res.writeHead(status, hop);
            res.end(html);
            resolve({ ok: true, status });
          } catch {
            resolve({ ok: false, status });
          }
        });
        return;
      }
      try {
        res.writeHead(status, hop);
        up.pipe(res);
        up.on('end', () => resolve({ ok: true, status }));
      } catch {
        resolve({ ok: false, status });
      }
    });
    incoming.on('timeout', () => incoming.destroy());
    incoming.on('error', () => resolve({ ok: false, status: 0 }));
    if (req.method === 'GET' || req.method === 'HEAD') incoming.end();
    else req.pipe(incoming);
  });
}

function builderHome(project) {
  const id = encodeURIComponent(project?.id || '');
  return id ? `/?p=${id}` : '/';
}

function page(title, body, project) {
  const home = builderHome(project);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui;background:#0e1116;color:#e8eef6;margin:0;padding:32px}a{color:#8b7cff}</style>
</head><body><h1>${title}</h1><p>${body}</p><p><a href="${home}">← Back to App Builder</a></p>
<script>setTimeout(function(){ location.replace(${JSON.stringify(home)}); }, 6000);</script>
</body></html>`;
}

function safeHtml(res, status, html) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

export function previewPath(slug) {
  return `/preview/${encodeURIComponent(slug)}/`;
}

export function resolvePreviewUpstream(runtime = {}) {
  const host = String(runtime.proxyHost || runtime.containerIp || '127.0.0.1');
  const port = Number(runtime.proxyPort || runtime.hostPort);
  if (!Number.isFinite(port) || port <= 0) return null;
  const builderPort = Number(process.env.PORT || 8080);
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (loopback && port === builderPort) return null;
  return { host, port };
}
