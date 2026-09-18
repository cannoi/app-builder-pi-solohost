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
      res.end(page('App not found', 'This preview link does not match a Builder project.', null));
      return true;
    }
    const runtime = await projects.readMetadata(project, 'runtime.json', {});
    const port = Number(runtime.hostPort);
    const ip = runtime.containerIp;
    if (runtime.status !== 'passed' || (!ip && !port)) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('App is not running', 'Go back to chat and tap ▶ Run. When it finishes, open this link again.', project));
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
    await proxy(req, res, host, targetPort, targetPath, project);
    return true;
  };
}

function proxy(req, res, hostname, port, targetPath, project) {
  return new Promise((resolve) => {
    const incoming = http.request({
      hostname,
      port,
      path: targetPath || '/',
      method: req.method,
      headers: { ...req.headers, host: `${hostname}:${port}` },
    }, (up) => {
      const contentType = String(up.headers['content-type'] || '');
      // Fix: inject an always-visible "back to Builder" bar into HTML pages served
      // through the preview proxy, so the user can always get out of the app under
      // test without relying on the host's own back/close button. Only HTML GET
      // responses that aren't already compressed are touched — everything else
      // (JS, CSS, images, JSON API calls) is streamed through unchanged, exactly as
      // before, so the app under test behaves identically.
      const canInject = req.method === 'GET' && contentType.includes('text/html') && !up.headers['content-encoding'];
      if (!canInject) {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
        up.on('end', resolve);
        return;
      }
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        // Defense in depth: this callback runs outside any promise chain the
        // caller can catch, so any error here (a bad header, an unexpected
        // encoding, etc.) must be handled right here or it becomes an uncaught
        // exception that can crash the whole server process — which is exactly
        // what an earlier missing `project` parameter here used to do on every
        // single HTML preview response.
        try {
          const html = injectBackBar(Buffer.concat(chunks).toString('utf8'), project);
          const headers = { ...up.headers };
          delete headers['transfer-encoding'];
          headers['content-length'] = Buffer.byteLength(html);
          res.writeHead(up.statusCode || 502, headers);
          res.end(html);
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(page('Preview error', 'The preview page could not be prepared. Go back to chat and try again.', project));
          } else {
            try { res.end(); } catch {}
          }
        }
        resolve();
      });
    });
    incoming.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Preview lost', 'The app container stopped. Tap ▶ Run in chat and try again.', project));
      }
      resolve();
    });
    req.pipe(incoming);
  });
}

function builderHome(project) {
  const id = encodeURIComponent(project?.id || '');
  return id ? `/?p=${id}` : '/';
}

function injectBackBar(html, project) {
  const home = builderHome(project);
  const bar = `<div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:8px 12px;background:#0e1116;color:#e8eef6;font:600 13px system-ui,sans-serif;border-bottom:1px solid #293241;box-shadow:0 2px 10px #0006" id="__paf-back-bar"><a href="${home}" style="color:#8b7cff;text-decoration:none;font-weight:700;white-space:nowrap">← Back to Builder</a><span style="opacity:.55;font-weight:400">Test preview</span></div><div style="height:38px" id="__paf-back-spacer"></div>`;
  // White-screen watchdog: some previewed apps fail to render anything on their
  // own (JS crash, blank React root, etc.) without our proxy seeing any error —
  // there's no way back in that case since the page is otherwise empty. After a
  // grace period, check whether the page (excluding our own bar) actually shows
  // anything; if not, auto-navigate back to this exact project's chat.
  const watchdog = `<script>(function(){
    function isBlank(){
      try {
        var b = document.body; if (!b) return true;
        var clone = b.cloneNode(true);
        var bar = clone.querySelector('#__paf-back-bar'); if (bar) bar.remove();
        var sp = clone.querySelector('#__paf-back-spacer'); if (sp) sp.remove();
        var text = (clone.innerText || clone.textContent || '').trim();
        var visual = clone.querySelector('img,canvas,svg,video,iframe,input,button,[style*="background"]');
        return text.length === 0 && !visual;
      } catch (e) { return false; }
    }
    setTimeout(function(){
      if (isBlank()) { window.location.replace(${JSON.stringify(home)}); }
    }, 4000);
  })();</script>`;
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, (m) => `${m}${bar}`).replace(/<\/body>/i, `${watchdog}</body>`);
  }
  return bar + html + watchdog;
}

function page(title, body, project) {
  const home = builderHome(project);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui;background:#0e1116;color:#e8eef6;margin:0;padding:32px}a{color:#8b7cff}</style>
</head><body><h1>${title}</h1><p>${body}</p><p><a href="${home}">← Back to App Builder</a></p></body></html>`;
}

export function previewPath(slug) {
  return `/preview/${encodeURIComponent(slug)}/`;
}
