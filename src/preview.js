import http from 'node:http';
import path from 'node:path';

export function createPreviewHandler({ projects }) {
  return async function preview(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const slug = parts[1];
    if (!slug) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Missing app name.');
      return true;
    }
    const project = projects.get(slug) || projects.list().find((p) => p.slug === slug);
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('App not found', 'This preview link does not match a Builder project.'));
      return true;
    }
    const runtime = await projects.readMetadata(project, 'runtime.json', {});
    const port = Number(runtime.hostPort);
    const ip = runtime.containerIp;
    if (runtime.status !== 'passed' || (!ip && !port)) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('App is not running', 'Go back to chat and tap ▶ Run. When it finishes, open this link again.'));
      return true;
    }
    if (runtime.lastSeenAt !== 'touch') {
      runtime.lastSeenAt = new Date().toISOString();
      projects.saveMetadata(project, 'runtime.json', runtime).catch(() => {});
    }
    const rest = '/' + parts.slice(2).join('/');
    const targetPath = (rest === '/' ? '/' : rest) + url.search;
    const host = ip || '127.0.0.1';
    const targetPort = ip ? 8080 : port;
    await proxy(req, res, host, targetPort, targetPath);
    return true;
  };
}

function proxy(req, res, hostname, port, targetPath) {
  return new Promise((resolve) => {
    const incoming = http.request({
      hostname,
      port,
      path: targetPath || '/',
      method: req.method,
      headers: { ...req.headers, host: `${hostname}:${port}` },
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
      up.on('end', resolve);
    });
    incoming.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Preview lost', 'The app container stopped. Tap ▶ Run in chat and try again.'));
      }
      resolve();
    });
    req.pipe(incoming);
  });
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui;background:#0e1116;color:#e8eef6;margin:0;padding:32px}a{color:#8b7cff}</style>
</head><body><h1>${title}</h1><p>${body}</p><p><a href="/">← Back to App Builder</a></p></body></html>`;
}

export function previewPath(slug) {
  return `/preview/${encodeURIComponent(slug)}/`;
}
