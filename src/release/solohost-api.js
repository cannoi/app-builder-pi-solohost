/**
 * SoloHost remote validation / preview-env client.
 */
const DEFAULT_BASE = 'https://solohost-nohcqud24xwnsmna.staging.piappengine.com';
const RETRIES = Number(process.env.SOLOHOST_VALIDATE_RETRIES || 4);
const RETRY_GAP_MS = Number(process.env.SOLOHOST_VALIDATE_RETRY_MS || 8000);

function apiBase() {
  const raw = process.env.SOLOHOST_API
    || process.env.SOLOHOST_VALIDATE_URL
    || DEFAULT_BASE;
  // If full validate URL was provided, strip path
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (u.pathname.includes('/api/apps')) {
      return `${u.origin}`;
    }
    return u.origin;
  } catch {
    return DEFAULT_BASE;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeErrors(data) {
  const raw = data?.errors || data?.message || data?.error || [];
  if (Array.isArray(raw)) {
    return raw.map((e) => {
      if (typeof e === 'string') return { rule: 'REMOTE', message: e };
      return {
        rule: e.rule || e.code || 'REMOTE',
        message: e.message || e.detail || e.error || JSON.stringify(e).slice(0, 200),
        path: e.path || null,
      };
    });
  }
  if (typeof raw === 'string') return [{ rule: 'REMOTE', message: raw }];
  if (raw && typeof raw === 'object') {
    return [{ rule: raw.rule || 'REMOTE', message: raw.message || JSON.stringify(raw).slice(0, 200) }];
  }
  return [];
}

/**
 * @returns {{ status: 'ok'|'fail'|'unreachable', errors: object[], authoritative?: boolean }}
 */
export async function validateRemote({ composeYaml, configOptionsYaml } = {}) {
  const base = apiBase();
  const url = `${base}/api/apps/validate`;
  let lastErr = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ composeYaml, configOptionsYaml }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < RETRIES - 1) await sleep(RETRY_GAP_MS);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data.ok === true || data.valid === true || data.success === true)) {
        return { status: 'ok', errors: [], authoritative: true };
      }
      return {
        status: 'fail',
        errors: normalizeErrors(data).length
          ? normalizeErrors(data)
          : [{ rule: 'REMOTE_FAIL', message: `Validator returned HTTP ${res.status}` }],
        authoritative: true,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES - 1) await sleep(RETRY_GAP_MS);
    }
  }
  return {
    status: 'unreachable',
    errors: [{
      rule: 'UNREACHABLE',
      message: String(lastErr?.message || lastErr || 'SoloHost validator unreachable').slice(0, 240),
    }],
    authoritative: false,
  };
}

export async function previewEnv({ configOptionsYaml, values = {} } = {}) {
  const base = apiBase();
  const url = `${base}/api/apps/preview-env`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configOptionsYaml, values }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || data.message || `HTTP ${res.status}`), { status: res.status });
  }
  return data;
}

export default { validateRemote, previewEnv };
