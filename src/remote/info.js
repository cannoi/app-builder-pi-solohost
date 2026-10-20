import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Public URL for remote QR.
 * Priority: PUBLIC_URL env → data/remote.json → X-Forwarded-* / Host
 * → PUBLIC_IP + SoloHost HOST_PORT (or SOLOHOST_HOST_PORT / PORT).
 */
export async function resolvePublicUrl({ cfg, req, dataDir }) {
  const fromEnv = process.env.PUBLIC_URL || cfg?.publicUrl || '';
  if (fromEnv) return { publicUrl: String(fromEnv).replace(/\/$/, ''), source: 'env' };

  try {
    const remote = JSON.parse(await fs.readFile(path.join(dataDir, 'remote.json'), 'utf8'));
    if (remote?.publicUrl) return { publicUrl: String(remote.publicUrl).replace(/\/$/, ''), source: 'user' };
  } catch { /* none */ }

  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || '';
  const xfProto = String(req?.headers?.['x-forwarded-proto'] || 'http').split(',')[0].trim();
  if (host && !/^(localhost|127\.0\.0\.1|\[::1\])/i.test(String(host).split(':')[0])) {
    return { publicUrl: `${xfProto}://${host}`.replace(/\/$/, ''), source: 'request' };
  }

  // SoloHost often exposes host port via env; public IP may be set by operator
  const publicIp = process.env.PUBLIC_IP || process.env.SOLOHOST_PUBLIC_IP || cfg?.publicIp || '';
  const hostPort =
    process.env.HOST_PORT ||
    process.env.SOLOHOST_HOST_PORT ||
    process.env.PUBLIC_PORT ||
    cfg?.hostPort ||
    '';
  if (publicIp && hostPort) {
    return {
      publicUrl: `http://${String(publicIp).replace(/^https?:\/\//, '')}:${String(hostPort)}`.replace(/\/$/, ''),
      source: 'solohost',
    };
  }
  if (publicIp) {
    return { publicUrl: `http://${String(publicIp).replace(/^https?:\/\//, '')}`.replace(/\/$/, ''), source: 'public_ip' };
  }

  return { publicUrl: '', source: 'none' };
}

export function isLoopbackRequest(req) {
  const host = String(req?.headers?.host || '').split(':')[0];
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host);
}
