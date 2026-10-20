import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

/**
 * One public link for remote QR:
 *   http://PUBLIC_IP:HOST_PORT
 *
 * IP  — same proven path as v1.8.13 (env → cache → ipify/ifconfig/icanhazip)
 * Port — SoloHost HOST_PORT (external publish), NOT container PORT/8080
 *        (TV app declares HOST_PORT in config_options for SoloHost to inject)
 */

const IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const IP_FETCH_TIMEOUT_MS = 4000;

const PUBLIC_IP_ENDPOINTS = [
  { url: 'https://api.ipify.org', parse: (t) => t.trim() },
  { url: 'https://ifconfig.me/ip', parse: (t) => t.trim() },
  { url: 'https://icanhazip.com', parse: (t) => t.trim() },
];

/** In-container ports — never use as the public SoloHost host port. */
const INTERNAL_PORTS = new Set([8080, 80, 443, 3000, 5000, 8000, 5173, 4173]);

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

function isValidExternalPort(n) {
  return Number.isFinite(n) && n > 0 && n < 65536 && !INTERNAL_PORTS.has(n);
}

function fetchText(url, timeoutMs = IP_FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { Accept: 'text/plain', 'User-Agent': 'AppBuilder-SoloHost/1' } }, (res) => {
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

/** v1.8.13-style public IP discovery */
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
    } catch { /* next */ }
  }
  return { ip: '', source: 'none' };
}

/**
 * SoloHost external host port (TV declares HOST_PORT in config_options.yml).
 * Never returns container PORT / 8080.
 */
export function detectHostPort({ req, cfg = {} } = {}) {
  const candidates = [
    process.env.HOST_PORT,
    process.env.SOLOHOST_HOST_PORT,
    process.env.PUBLIC_PORT,
    process.env.PI_HOST_PORT,
    process.env.APP_HOST_PORT,
    cfg?.hostPort,
    cfg?.publicPort,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (isValidExternalPort(n)) return { port: n, source: 'env' };
  }

  // Port embedded in SOLOHOST_PUBLIC_URL / PUBLIC_URL
  for (const key of ['SOLOHOST_PUBLIC_URL', 'PUBLIC_URL', 'APP_PUBLIC_URL']) {
    const u = process.env[key] || '';
    const m = String(u).match(/:(\d+)(?:\/|$)/);
    if (m) {
      const n = Number(m[1]);
      if (isValidExternalPort(n)) return { port: n, source: 'url' };
    }
  }

  const xfPort = String(req?.headers?.['x-forwarded-port'] || '').split(',')[0].trim();
  if (/^\d+$/.test(xfPort)) {
    const n = Number(xfPort);
    if (isValidExternalPort(n)) return { port: n, source: 'forwarded' };
  }

  const hostHeader = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '');
  const hostPortMatch = hostHeader.match(/:(\d+)\s*$/);
  if (hostPortMatch && !isLoopbackHost(hostHeader)) {
    const n = Number(hostPortMatch[1]);
    if (isValidExternalPort(n)) return { port: n, source: 'request' };
  }

  return { port: 0, source: 'none' };
}

export async function resolvePublicUrl({ cfg, req, dataDir }) {
  // 1) Explicit full URL (TV: SOLOHOST_PUBLIC_URL / PUBLIC_URL)
  const fromEnv =
    process.env.SOLOHOST_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    process.env.APP_PUBLIC_URL ||
    cfg?.publicUrl ||
    '';
  if (fromEnv) {
    return {
      publicUrl: stripSlash(fromEnv),
      source: 'env',
      publicIp: '',
      hostPort: 0,
    };
  }

  // 2) User-saved override
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

  // 3) Non-loopback Host / X-Forwarded (SoloHost reverse proxy) — TV style
  const xfHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim();
  const xfProto = String(req?.headers?.['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  if (xfHost && !isLoopbackHost(xfHost)) {
    return {
      publicUrl: stripSlash(`${xfProto}://${xfHost}`),
      source: 'request',
      publicIp: xfHost.split(':')[0],
      hostPort: Number(xfHost.match(/:(\d+)$/)?.[1] || 0) || 0,
    };
  }

  // 4) Auto: public IP (v1.8.13) + SoloHost HOST_PORT
  const { ip, source: ipSource } = await detectPublicIp({ dataDir, cfg });
  const { port, source: portSource } = detectHostPort({ req, cfg });

  if (ip && port) {
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
    hostPort: port || 0,
    ipSource,
    portSource,
    hint: !ip ? 'public_ip_missing' : 'host_port_missing',
  };
}

export function isLoopbackRequest(req) {
  const host = String(req?.headers?.host || '').split(':')[0];
  return isLoopbackHost(host);
}
