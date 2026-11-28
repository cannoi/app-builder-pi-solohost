import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Prefer high user ports to avoid clashing with system services and fixed 18080 demos. */
export const PORT_MIN = 20000;
export const PORT_MAX = 49151;

const AVOID = new Set([
  18080, 18000, 18180, 18443, 18888,
  22000, 27017, 3306, 5432, 6379, 8080, 8443, 9000,
]);

function inPreferredRange(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= PORT_MIN && n <= PORT_MAX && !AVOID.has(n);
}

function inHostRange(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}

/**
 * Stable host port derived from project slug (deterministic, high range).
 * Not fixed to 18080 — each app gets its own port in 20000–49151.
 */
export function hashPort(slug) {
  const h = crypto.createHash('sha256').update(String(slug || 'app')).digest();
  const span = PORT_MAX - PORT_MIN + 1;
  let port = PORT_MIN + (h.readUInt32BE(0) % span);
  // Skip reserved / avoided values with a fixed stride so the mapping stays pure.
  for (let i = 0; i < 32 && AVOID.has(port); i += 1) {
    port = PORT_MIN + ((port - PORT_MIN + 97) % span);
  }
  return port;
}

/**
 * True random high port (for one-off allocation). Prefer over fixed 18080.
 */
export function randomHighPort() {
  const span = PORT_MAX - PORT_MIN + 1;
  for (let i = 0; i < 24; i += 1) {
    const port = PORT_MIN + crypto.randomInt(span);
    if (!AVOID.has(port)) return port;
  }
  return hashPort(`rnd-${Date.now()}`);
}

/**
 * Prefer existing valid loopback port from compose; else explicit; else hash(slug); persist.
 * Accepts full host range 1024–65535 when already declared in compose.
 */
export async function stableHostPort(project, explicit = null, sourceDir = null) {
  if (explicit != null && inHostRange(explicit)) return Number(explicit);

  const slug = project?.slug || project?.name || 'app';

  try {
    const dir = sourceDir || project?.sourceDir;
    if (dir) {
      for (const rel of ['solohost/docker-compose.yml', 'docker-compose.yml']) {
        const raw = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '');
        const m = raw.match(/127\.0\.0\.1:(\d{2,5}):\d+/);
        if (m) {
          const port = Number(m[1]);
          if (inHostRange(port)) return port;
        }
      }
    }
  } catch { /* fall through */ }

  try {
    if (project?._metaDir) {
      const metaPath = path.join(project._metaDir, 'solohost-port.json');
      const raw = await fs.readFile(metaPath, 'utf8').catch(() => '');
      if (raw) {
        const j = JSON.parse(raw);
        if (inHostRange(j.hostPort)) return Number(j.hostPort);
      }
      const port = hashPort(slug);
      await fs.mkdir(project._metaDir, { recursive: true }).catch(() => {});
      await fs.writeFile(metaPath, JSON.stringify({ hostPort: port, slug, range: `${PORT_MIN}-${PORT_MAX}` }, null, 2)).catch(() => {});
      return port;
    }
  } catch { /* fall through */ }

  return hashPort(slug);
}

export default { hashPort, randomHighPort, stableHostPort, PORT_MIN, PORT_MAX, inPreferredRange };
