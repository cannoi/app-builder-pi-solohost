/* Personal AI Hub SDK - browser client for SoloHost apps. */
(function (global) {
  function headers(token, appId) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['X-Personal-AI-Key'] = token;
    if (appId) h['X-SoloHost-App-ID'] = appId;
    return h;
  }
  async function call(base, path, body, options) {
    options = options || {};
    var r = await fetch(String(base || '').replace(/\/$/, '') + path, {
      method: 'POST',
      headers: headers(options.token, options.appId),
      body: JSON.stringify(body || {})
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok || (data.error && !data.reply)) throw new Error(data.message || data.error || ('HTTP ' + r.status));
    return data;
  }
  async function get(base, path) {
    var r = await fetch(String(base || '').replace(/\/$/, '') + path);
    return r.json();
  }
  global.PersonalAIHub = {
    /** POST /api/v1/chat — uses Hub providers (you do not send cloud API keys). */
    chat: function (message, options) {
      options = options || {};
      return call(options.baseUrl || '', '/api/v1/chat', {
        message: message,
        provider: options.provider,
        model: options.model,
        appId: options.appId
      }, options);
    },
    health: function (baseUrl) { return get(baseUrl || '', '/api/v1/health'); },
    providers: function (baseUrl) { return get(baseUrl || '', '/api/v1/providers'); },
    gateway: function (baseUrl) { return get(baseUrl || '', '/api/v1/gateway'); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
