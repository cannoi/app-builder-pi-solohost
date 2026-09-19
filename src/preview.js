import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

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

    if (runtime.status === 'passed' && target) {
      const ok = await proxy(req, res, target.host, target.port, targetPath, project);
      if (ok) return true;
    }
    const sourceDir = projects.sourceDir(project.slug);
    if (serveProjectFile(sourceDir, targetPath, res)) return true;
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

function serveProjectFile(sourceDir, targetPath, res) {
  const clean = decodeURIComponent(String(targetPath || '/').split('?')[0] || '/');
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const roots = ['public', 'dist', 'www', ''].map((d) => path.join(sourceDir, d));
  for (const root of roots) {
    const file = path.normalize(path.join(root, rel === 'index.html' && clean !== '/' ? rel : rel));
    const index = path.join(root, 'index.html');
    const candidate = fs.existsSync(file) && fs.statSync(file).isFile() ? file
      : (clean === '/' || rel === 'index.html') && fs.existsSync(index) ? index
      : null;
    if (!candidate || !candidate.startsWith(root)) continue;
    try {
      const data = fs.readFileSync(candidate);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(candidate).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
      return true;
    } catch { return false; }
  }
  return false;
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
      const hop = { ...up.headers };
      delete hop.connection;
      delete hop['keep-alive'];
      // The Builder owns the preview frame. Generated apps must not be able to
      // blank the frame with their own X-Frame-Options/CSP frame-ancestors.
      delete hop['x-frame-options'];
      delete hop['content-security-policy'];
      try {
        res.writeHead(up.statusCode || 502, hop);
        up.pipe(res);
        up.on('end', () => resolve(true));
      } catch {
        resolve(false);
      }
    });
    incoming.on('timeout', () => incoming.destroy());
    incoming.on('error', () => resolve(false));
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
