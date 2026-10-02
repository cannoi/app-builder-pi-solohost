import crypto from 'node:crypto';

const COOKIE = 'builder_session';
const SESSION_SECONDS = 12 * 60 * 60;
const MIN_PASSWORD_LENGTH = 16;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;

export function createAccessAuth(password) {
  const secret = String(password || '');
  const configured = secret.length >= MIN_PASSWORD_LENGTH;
  const secretKey = crypto.createHash('sha256').update(secret).digest();
  const loginAttempts = new Map();

  function signature(expires) {
    return crypto.createHmac('sha256', secretKey).update(`builder-session:${expires}`).digest('hex');
  }

  function isAuthenticated(req) {
    if (!configured) return false;
    const cookies = String(req.headers.cookie || '').split(';').map((part) => part.trim());
    const value = cookies.find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
    const [expiresText, suppliedSignature] = value.split('.');
    const expires = Number(expiresText);
    if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + SESSION_SECONDS) return false;
    const expected = Buffer.from(signature(expires), 'hex');
    let supplied;
    try { supplied = Buffer.from(suppliedSignature || '', 'hex'); } catch { return false; }
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  function middleware(req, res) {
    const path = String(req.path || '');
    const protectedPath = path.startsWith('/api/') || path === '/preview' || path.startsWith('/preview/');
    if (!protectedPath || path === '/api/auth/login' || path === '/api/auth/status') return true;
    if (path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch {}
        if (!originHost || originHost !== req.headers.host) {
          res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
          return false;
        }
      }
    }
    if (!configured) {
      res.status(503);
      res.setHeader('X-Builder-Auth', 'configuration-required');
      res.json({
        error: `Set BUILDER_ACCESS_PASSWORD to a password with at least ${MIN_PASSWORD_LENGTH} characters in SoloHost settings, then restart Builder.`,
      });
      return false;
    }
    if (isAuthenticated(req)) return true;
    res.status(401);
    res.setHeader('X-Builder-Auth', 'required');
    res.json({ error: 'Sign in to App Builder to continue.' });
    return false;
  }

  function login(req, res) {
    if (!configured) {
      res.status(503);
      res.setHeader('X-Builder-Auth', 'configuration-required');
      res.json({
        error: `Set BUILDER_ACCESS_PASSWORD to a password with at least ${MIN_PASSWORD_LENGTH} characters in SoloHost settings, then restart Builder.`,
      });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch {}
      if (!originHost || originHost !== req.headers.host) {
        res.status(403).json({ error: 'Sign-in request origin is not allowed.' });
        return;
      }
    }
    const ip = String(req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    const attempts = (loginAttempts.get(ip) || []).filter((stamp) => stamp > now - LOGIN_WINDOW_MS);
    if (attempts.length >= LOGIN_LIMIT) {
      loginAttempts.set(ip, attempts);
      res.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
      return;
    }
    const candidate = crypto.createHash('sha256').update(String(req.body?.password || '')).digest();
    const expected = crypto.createHash('sha256').update(secret).digest();
    if (!crypto.timingSafeEqual(candidate, expected)) {
      attempts.push(now);
      loginAttempts.set(ip, attempts);
      res.status(401).json({ error: 'Password is incorrect.' });
      return;
    }
    loginAttempts.delete(ip);
    const expires = Math.floor(now / 1000) + SESSION_SECONDS;
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted === true;
    res.setHeader('Set-Cookie', `${COOKIE}=${expires}.${signature(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  }

  function logout(req, res) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted === true;
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  }

  return { configured, isAuthenticated, middleware, login, logout };
}
