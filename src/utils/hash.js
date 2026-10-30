import { createHash } from 'node:crypto';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha1(data) {
  return createHash('sha1').update(data).digest('hex');
}

export function fileClass(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (/(^|\/)\.env\.example$/i.test(p) || /(^|\/)\.env\.sample$/i.test(p) || /(^|\/)\.env\.template$/i.test(p)) return 'AUTO_MODIFIABLE_TEMPLATE';
  if (/(^|\/)\.env$/i.test(p) || /(^|\/)id_rsa($|\.)/i.test(p) || /private[_-]?key/i.test(p) || /(^|\/)credentials\.json$/i.test(p)) return 'ABSOLUTELY_PROTECTED';
  return 'NORMAL_SOURCE';
}
