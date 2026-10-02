export async function forwardHubFeedback({ config = {}, type, message, locale = 'en', fetchImpl = fetch }) {
  if (!config.hubUrl || !config.hubId || !config.ingestToken) {
    throw Object.assign(new Error('Feedback Hub is not configured.'), { code: 'FEEDBACK_NOT_CONFIGURED' });
  }
  let hub;
  try { hub = new URL(String(config.hubUrl)); } catch {}
  if (!hub || hub.protocol !== 'https:' || hub.username || hub.password || hub.search || hub.hash || hub.pathname !== '/') {
    throw new Error('Feedback Hub URL must be an HTTPS origin.');
  }

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 12000);
  try {
    const response = await fetchImpl(new URL('/api/feedback', hub), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-SHFH-Hub-ID': String(config.hubId),
        Authorization: `Bearer ${config.ingestToken}`,
      },
      body: JSON.stringify({
        schema_version: '2.2',
        app_id: config.appId || 'app-builder-pi-solohost',
        app_name: config.appName || 'App Builder — Pi SoloHost',
        version: config.version || '1.4.61',
        platform: 'solohost',
        locale: String(locale || 'en').slice(0, 16),
        event: 'feedback',
        hub_id: String(config.hubId),
        type,
        rating: 0,
        message,
      }),
      signal: abort.signal,
    });
    if (!response.ok) throw new Error('Feedback Hub rejected the submission.');
    return { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}
