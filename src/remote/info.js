import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

/**
 * Public URL for remote QR (phones outside the LAN).
 *
 * Priority:
 *  1) PUBLIC_URL env / cfg
 *  2) data/remote.json (user override)
 *  3) Non-loopback Host / X-Forwarded-*
 *  4) Auto: public IP (env or discovery) + SoloHost host port
 */

const IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const IP_FETCH_TIMEOUT_MS = 3500;

const PUBLIC_IP_ENDPOINTS = [
  { url: 'https://api.ipify.org', parse: (t) => t.trim() },
  { url: 'https://ifconfig.me/ip', parse: (t) => t.trim() },
  { url: 'https://icanhazip.com', parse: (t) => t.trim() },
];

function stripSlash(u) {
  return String(u || '').trim().replace(/\/$/, '');
}

function isLoopbackHost(host) {
  const h = String(host || '').split(':')[0].replace(/^\[|\]$/g, '');
  return /^(localhost|127\.0\.0\.1|::1)$/i.test(h);
}

function isPrivateIp(ip) {
  const s = String(ip || '');
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|127\.|0\.|::1|fc|fd)/i.test(s);
}

function fetchText(url, timeoutMs = IP_FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { Accept: 'text/plain' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function readIpCache(dataDir) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'public-ip-cache.json'), 'utf8'));
    if (raw?.ip && raw?.at && Date.now() - Number(raw.at) < IP_CACHE_TTL_MS) return String(raw.ip);
  } catch { /* none */ }
  return '';
}

async function writeIpCache(dataDir, ip) {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'public-ip-cache.json'),
      JSON.stringify({ ip, at: Date.now() }, null, 2),
    );
  } catch { /* ignore */ }
}

/**
 * Discover the public IPv4 of the SoloHost machine.
 */
export async function detectPublicIp({ dataDir = '', cfg = {} } = {}) {
  const fromEnv =
    process.env.PUBLIC_IP ||
    process.env.SOLOHOST_PUBLIC_IP ||
    process.env.PI_PUBLIC_IP ||
    cfg?.publicIp ||
    '';
  if (fromEnv && !isPrivateIp(fromEnv)) return { ip: String(fromEnv).trim(), source: 'env' };

  if (dataDir) {
    const cached = await readIpCache(dataDir);
    if (cached) return { ip: cached, source: 'cache' };
  }

  for (const ep of PUBLIC_IP_ENDPOINTS) {
    try {
      const text = await fetchText(ep.url);
      const ip = ep.parse(text);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !isPrivateIp(ip)) {
        if (dataDir) await writeIpCache(dataDir, ip);
        return { ip, source: 'discover' };
      }
    } catch { /* try next */ }
  }
  return { ip: '', source: 'none' };
}

/**
 * SoloHost-assigned host port for this app (the port on the public IP).
 * Container may listen on 8080 while SoloHost maps e.g. 18144 → 8080.
 */
/** Container-only ports — never use these as the public SoloHost host port. */
const INTERNAL_PORTS = new Set([8080, 80, 443, 3000, 5000, 8000, 5173, 4173]);

function isValidExternalPort(n) {
  return Number.isFinite(n) && n > 0 && n < 65536 && !INTERNAL_PORTS.has(n);
}

/**
 * SoloHost-assigned host port (outside the container).
 * Never returns 8080/PORT inside the container.
 */
export function detectHostPort({ req, cfg = {} } = {}) {
  const candidates = [
    process.env.HOST_PORT,
    process.env.SOLOHOST_HOST_PORT,
    process.env.PUBLIC_PORT,
    process.env.PI_HOST_PORT,
    process.env.SOLOHOST_PORT,
    process.env.APP_HOST_PORT,
    cfg?.hostPort,
    cfg?.publicPort,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (isValidExternalPort(n)) return { port: n, source: 'env' };
  }

  const xfPort = String(req?.headers?.['x-forwarded-port'] || '').split(',')[0].trim();
  if (/^\d+$/.test(xfPort)) {
    const n = Number(xfPort);
    // SoloHost reverse-proxy may forward the external port
    if (isValidExternalPort(n)) return { port: n, source: 'forwarded' };
  }

  const hostHeader = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '');
  const hostPortMatch = hostHeader.match(/:(\d+)\s*$/);
  if (hostPortMatch && !isLoopbackHost(hostHeader)) {
    const n = Number(hostPortMatch[1]);
    if (isValidExternalPort(n)) return { port: n, source: 'request' };
  }

  // Do NOT fall back to process.env.PORT / 8080 — that is the in-container port.
  return { port: 0, source: 'none' };
}

export async function resolvePublicUrl({ cfg, req, dataDir }) {
  const fromEnv = process.env.PUBLIC_URL || cfg?.publicUrl || '';
  if (fromEnv) {
    return {
      publicUrl: stripSlash(fromEnv),
      source: 'env',
      publicIp: '',
      hostPort: 0,
    };
  }

  try {
    const remote = JSON.parse(await fs.readFile(path.join(dataDir, 'remote.json'), 'utf8'));
    if (remote?.publicUrl) {
      return {
        publicUrl: stripSlash(remote.publicUrl),
        source: 'user',
        publicIp: '',
        hostPort: 0,
      };
    }
  } catch { /* none */ }

  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || '';
  const xfProto = String(req?.headers?.['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  if (host && !isLoopbackHost(host)) {
    return {
      publicUrl: stripSlash(`${xfProto}://${host}`),
      source: 'request',
      publicIp: String(host).split(':')[0],
      hostPort: Number(String(host).match(/:(\d+)$/)?.[1] || 0) || 0,
    };
  }

  const { ip, source: ipSource } = await detectPublicIp({ dataDir, cfg });
  const { port, source: portSource } = detectHostPort({ req, cfg });

  // Single canonical link only: public IP + SoloHost external host port (never container 8080)
  if (ip && port && !INTERNAL_PORTS.has(port)) {
    return {
      publicUrl: `http://${ip}:${port}`,
      source: 'solohost-auto',
      publicIp: ip,
      hostPort: port,
      ipSource,
      portSource,
    };
  }

  return {
    publicUrl: '',
    source: 'none',
    publicIp: ip || '',
    hostPort: (port && !INTERNAL_PORTS.has(port)) ? port : 0,
    ipSource,
    portSource,
    hint: !ip
      ? 'public_ip_missing'
      : (!port || INTERNAL_PORTS.has(port) ? 'host_port_missing' : 'unknown'),
  };
}

export function isLoopbackRequest(req) {
  const host = String(req?.headers?.host || '').split(':')[0];
  return isLoopbackHost(host);
}
