/**
 * Optional remote access gate using BUILDER_ACCESS_PASSWORD.
 * When unset/empty, auth is disabled (local dev stays open).
 */
import crypto from 'node:crypto';

const COOKIE = 'builder_access';
const MAX_AGE_SEC = 60 * 60 * 24 * 7;

export function accessPasswordConfigured(cfg) {
  return Boolean(cfg?.accessPassword && String(cfg.accessPassword).length > 0);
}

function tokenFor(password) {
  return crypto.createHmac('sha256', 'builder-access-v1').update(String(password)).digest('hex');
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

export function isAccessAuthorized(req, cfg) {
  if (!accessPasswordConfigured(cfg)) return true;
  const expected = tokenFor(cfg.accessPassword);
  const cookies = parseCookies(req.headers?.cookie);
  if (cookies[COOKIE] && cookies[COOKIE] === expected) return true;
  const auth = String(req.headers?.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === expected) return true;
  const hdr = req.headers?.['x-builder-access'];
  if (hdr && String(hdr) === expected) return true;
  return false;
}

export function verifyAccessPassword(password, cfg) {
  if (!accessPasswordConfigured(cfg)) return { ok: true, token: null };
  const ok = String(password || '') === String(cfg.accessPassword);
  return { ok, token: ok ? tokenFor(cfg.accessPassword) : null };
}

export function accessCookieHeader(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SEC}`;
}

export function createAccessAuthMiddleware(cfg) {
  return function accessAuth(req, res, next) {
    const path = req.path || req.url || '';
    if (
      path === '/api/access/status' || path === '/api/access/login' || path === '/api/access/logout'
      || path === '/login.html' || path === '/favicon.ico' || path === '/app-logo.jpg'
      || path === '/made-by.png' || path === '/styles.css'
    ) return next();
    if (isAccessAuthorized(req, cfg)) return next();
    if (String(path).startsWith('/api/')) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'ACCESS_PASSWORD_REQUIRED', message: 'Enter the Builder access password.' }));
    }
    res.statusCode = 302;
    res.setHeader('Location', '/login.html');
    return res.end();
  };
}
