import crypto from 'node:crypto';

export function uuid() {
  return crypto.randomUUID();
}

export function shortId(prefix = 'p') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

export function buildJobId() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `BUILD-${stamp}-${rand}`;
}

export function safeSlug(input, fallback = 'my-app') {
  const s = String(input || fallback)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

export function semverBump(version, kind = 'patch') {
  const [a, b, c] = String(version || '0.1.0').split('.').map((n) => Number(n) || 0);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}
