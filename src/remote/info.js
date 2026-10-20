import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

/**
 * Public access URL — same model as Snake Arcade (SoloHost):
 *
 * Port: learn from each real request (Host / X-Forwarded-Port).
 *       That is the SoloHost-published host port, never container PORT/8080.
 * IP:   PUBLIC_IP env, then api.ipify.org / ipv4.icanhazip.com / ifconfig.me
 * URL:  PUBLIC_URL → non-loopback Host URL → http://PUBLIC_IP:advertisedPort
 */

const IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const IP_FETCH_TIMEOUT_MS = 2500;

const PUBLIC_IP_ENDPOINTS = [
  { url: 'https://api.ipify.org', parse: (t) => t.trim() },
  { url: 'https://ipv4.icanhazip.com', parse: (t) => t.trim() },
  { url: 'https://ifconfig.me/ip', parse: (t) => t.trim() },
];

const INTERNAL_PORTS = new Set([8080, 80, 443, 3000, 5000, 8000, 5173, 4173]);

/** Last public/host port seen on a real request (SoloHost). NEVER the internal container PORT. */
let advertisedPort = '';
/** Cached discovered public IPv4 */
let publicIpMem = '';

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

function headerGet(headers, key) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(key) || headers.get(String(key).toLowerCase()) || '';
  }
  return headers[key] || headers[String(key).toLowerCase()] || '';
}

/**
 * Remember SoloHost public port from request headers (Snake rememberPublicPort).
 * Accepts ports from Host even when host is localhost — SoloHost maps e.g. host:31877 → container:8080.
 */
export function rememberPublicPort(headersOrReq) {
  const headers = headersOrReq?.headers || headersOrReq;
  if (!headers) return advertisedPort;
  const xf = String(headerGet(headers, 'x-forwarded-port') || '').split(',')[0].trim();
  const host = String(headerGet(headers, 'x-forwarded-host') || headerGet(headers, 'host') || '')
    .split(',')[0]
    .trim();
  const fromHost = (host.match(/:(\d+)$/) || [])[1] || '';
  const p = xf || fromHost;
  if (p && /^\d+$/.test(p)) {
    const n = Number(p);
    // Prefer non-internal ports; still accept if it's the only signal and not 8080
    if (n > 0 && n < 65536 && !INTERNAL_PORTS.has(n)) {
      advertisedPort = String(n);
    }
  }
  return advertisedPort;
}

export function getAdvertisedPort() {
  return advertisedPort ? Number(advertisedPort) : 0;
}

function lanIps() {
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
      .map((i) => i.address);
  } catch {
    return [];
  }
}

function fetchText(url, timeoutMs = IP_FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      timeout: timeoutMs,
      headers: { Accept: 'text/plain', 'User-Agent': 'AppBuilder-SoloHost/1' },
    }, (res) => {
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

/** Snake-style public IP (env + discover). */
export async function detectPublicIp({ dataDir = '', cfg = {}, force = false } = {}) {
  const fromEnv =
    process.env.PUBLIC_IP ||
    process.env.SOLOHOST_PUBLIC_IP ||
    process.env.PI_PUBLIC_IP ||
    cfg?.publicIp ||
    '';
  if (fromEnv && !isPrivateIp(fromEnv)) {
    publicIpMem = String(fromEnv).trim();
    return { ip: publicIpMem, source: 'env' };
  }

  if (!force && publicIpMem) return { ip: publicIpMem, source: 'memory' };

  if (dataDir && !force) {
    const cached = await readIpCache(dataDir);
    if (cached) {
      publicIpMem = cached;
      return { ip: cached, source: 'cache' };
    }
  }

  for (const ep of PUBLIC_IP_ENDPOINTS) {
    try {
      const text = await fetchText(ep.url);
      const ip = ep.parse(text);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !isPrivateIp(ip)) {
        publicIpMem = ip;
        if (dataDir) await writeIpCache(dataDir, ip);
        return { ip, source: 'discover' };
      }
    } catch { /* next */ }
  }
  return { ip: publicIpMem || '', source: publicIpMem ? 'memory' : 'none' };
}

/**
 * Host port priority (Snake + SoloHost env):
 * 1) advertisedPort learned from requests
 * 2) HOST_PORT / SOLOHOST_HOST_PORT env
 * 3) current request Host / X-Forwarded-Port
 */
export function detectHostPort({ req, cfg = {} } = {}) {
  if (req) rememberPublicPort(req);

  if (advertisedPort) {
    const n = Number(advertisedPort);
    if (n > 0 && !INTERNAL_PORTS.has(n)) return { port: n, source: 'request' };
  }

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
    if (Number.isFinite(n) && n > 0 && n < 65536 && !INTERNAL_PORTS.has(n)) {
      advertisedPort = String(n);
      return { port: n, source: 'env' };
    }
  }

  return { port: 0, source: 'none' };
}

export async function resolvePublicUrl({ cfg, req, dataDir }) {
  if (req) rememberPublicPort(req);

  // 1) Explicit PUBLIC_URL
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
      publicIp: publicIpMem || '',
      hostPort: getAdvertisedPort(),
      lanUrls: [],
    };
  }

  // 2) User override
  try {
    const remote = JSON.parse(await fs.readFile(path.join(dataDir, 'remote.json'), 'utf8'));
    if (remote?.publicUrl) {
      return {
        publicUrl: stripSlash(remote.publicUrl),
        source: 'user',
        publicIp: publicIpMem || '',
        hostPort: getAdvertisedPort(),
        lanUrls: [],
      };
    }
  } catch { /* none */ }

  const { port, source: portSource } = detectHostPort({ req, cfg });
  const { ip, source: ipSource } = await detectPublicIp({ dataDir, cfg });

  const host = String(
    headerGet(req?.headers, 'x-forwarded-host') || headerGet(req?.headers, 'host') || '',
  )
    .split(',')[0]
    .trim();
  const proto =
    String(headerGet(req?.headers, 'x-forwarded-proto') || 'http').split(',')[0].trim() || 'http';

  // 3) Non-loopback Host URL (Snake reqUrl)
  const reqUrl = host && !isLoopbackHost(host) ? stripSlash(`${proto}://${host}`) : '';

  // 4) http://PUBLIC_IP:advertisedPort
  const autoUrl = ip && port ? `http://${ip}:${port}` : '';

  const publicUrl = reqUrl || autoUrl || '';
  const lanUrls = port ? lanIps().map((lip) => `http://${lip}:${port}`) : [];

  return {
    publicUrl,
    source: publicUrl ? (reqUrl ? 'request' : 'solohost-auto') : 'none',
    publicIp: ip || '',
    hostPort: port || 0,
    ipSource,
    portSource,
    lanUrls,
    urls: [publicUrl, ...lanUrls].filter(Boolean),
    hint: publicUrl ? '' : (!ip ? 'public_ip_missing' : 'host_port_missing'),
  };
}

export function isLoopbackRequest(req) {
  const host = String(headerGet(req?.headers, 'host') || '').split(':')[0];
  return isLoopbackHost(host);
}

/** Test helper: reset learned port between tests */
export function _resetAdvertisedPortForTests() {
  advertisedPort = '';
  publicIpMem = '';
}
