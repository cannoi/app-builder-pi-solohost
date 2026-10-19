import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const AVOID = new Set([18080, 18000, 18180, 18443, 18888]);

export function hashPort(slug) {
  const h = crypto.createHash('sha256').update(String(slug || 'app')).digest();
  const n = h.readUInt32BE(0) % 1000; // 0..999
  let port = 18000 + n;
  if (AVOID.has(port) || port === 18080) port = 18000 + ((n + 17) % 1000);
  return port;
}

/**
 * Prefer existing valid loopback port from compose; else hash(slug); persist via optional projects API.
 */
export async function stableHostPort(project, explicit = null, sourceDir = null) {
  if (explicit && Number(explicit) >= 18000 && Number(explicit) <= 18999) return Number(explicit);
  const slug = project?.slug || project?.name || 'app';
  // Prefer loopback host port already in compose
  try {
    const dir = sourceDir || project?.sourceDir;
    if (dir) {
      for (const rel of ['solohost/docker-compose.yml', 'docker-compose.yml']) {
        const raw = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '');
        const m = raw.match(/127\.0\.0\.1:(\d{4,5}):\d+/);
        if (m) {
          const port = Number(m[1]);
          if (port >= 18000 && port <= 18999) return port;
        }
      }
    }
  } catch {}

  // Try metadata file if projectDir available
  try {
    if (project?._metaDir) {
      const metaPath = path.join(project._metaDir, 'solohost-port.json');
      const raw = await fs.readFile(metaPath, 'utf8').catch(() => '');
      if (raw) {
        const j = JSON.parse(raw);
        if (j.hostPort >= 18000 && j.hostPort <= 18999) return j.hostPort;
      }
      const port = hashPort(slug);
      await fs.mkdir(project._metaDir, { recursive: true }).catch(() => {});
      await fs.writeFile(metaPath, JSON.stringify({ hostPort: port, slug }, null, 2)).catch(() => {});
      return port;
    }
  } catch { /* fall through */ }
  return hashPort(slug);
}

export default { hashPort, stableHostPort };
