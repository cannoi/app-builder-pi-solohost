import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const BIND = process.env.BIND || '0.0.0.0';
const publicDir = path.join(__dirname, '..', 'public');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: '{{APP_SLUG}}' }));
    return;
  }
  const file = req.url === '/' ? '/index.html' : req.url;
  const target = path.normalize(path.join(publicDir, file));
  if (!target.startsWith(publicDir)) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(PORT, BIND, () => {
  console.log(`{{APP_NAME}} listening on ${BIND}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
