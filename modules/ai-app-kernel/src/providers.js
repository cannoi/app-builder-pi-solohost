import {
  collectAvailableKeys,
  defaultBaseUrl,
  detectProviderFromToken,
  discoverModelsDetailed,
  isLocalProvider,
  modelsFor,
  normalizeModel,
} from './router.js';

const CATALOG = {
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', kind: 'openai' },
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', kind: 'openai' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', kind: 'openai' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', kind: 'openai' },
  mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', kind: 'openai' },
  xai: { name: 'xAI', url: 'https://api.x.ai/v1/chat/completions', kind: 'openai' },
  gemini: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta', kind: 'gemini' },
  ollama: { name: 'Ollama (local)', url: 'http://127.0.0.1:11434/v1/chat/completions', kind: 'openai', local: true },
  lmstudio: { name: 'LM Studio (local)', url: 'http://127.0.0.1:1234/v1/chat/completions', kind: 'openai', local: true },
  local: { name: 'Local OpenAI-compatible', url: '', kind: 'openai', local: true },
  custom: { name: 'Custom', url: '', kind: 'openai' },
};

function envKey(id) {
  const specific = process.env[`${String(id).toUpperCase()}_API_KEY`] || '';
  if (specific) return specific;
  const generic = process.env.AI_API_KEY || '';
  if (generic && detectProviderFromToken(generic) === id) return generic;
  if (id === 'openai' && process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return '';
}

export function listProviders() {
  return Object.entries(CATALOG).map(([id, p]) => ({
    id,
    name: p.name,
    kind: p.kind,
    local: Boolean(p.local),
  }));
}

export { detectProviderFromToken, collectAvailableKeys, isLocalProvider };

export async function completeChat({
  provider = process.env.AI_PROVIDER || 'openai',
  model = process.env.AI_MODEL || '',
  apiKey = '',
  baseUrl = '',
  system = '',
  messages = [],
  tools = [],
  json = false,
  temperature = 0.2,
  timeoutMs = 0,
}) {
  const meta = CATALOG[provider] || CATALOG.custom;
  const local = Boolean(meta.local) || isLocalProvider(provider);
  const key = apiKey || envKey(provider) || (local ? 'local' : '');
  if (!key && !local) {
    throw new Error(`AI key missing for provider "${provider}". Set ${String(provider).toUpperCase()}_API_KEY or AI_API_KEY.`);
  }
  if (meta.kind === 'gemini' || provider === 'gemini') {
    return geminiChat({ key, model: normalizeModel('gemini', model || 'gemini-2.5-flash'), system, messages, tools, json, timeoutMs });
  }
  const url = baseUrl || defaultBaseUrl(provider) || meta.url;
  if (!url) throw new Error('Custom/local provider needs baseUrl (LOCAL_AI_BASE_URL or AI_BASE_URL).');
  const body = {
    model: model || defaultModel(provider),
    temperature,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages,
    ],
  };
  if (tools.length) body.tools = tools.map(openaiTool);
  if (json) body.response_format = { type: 'json_object' };
  const headers = { 'Content-Type': 'application/json' };
  if (key && key !== 'local') headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  const msg = data.choices?.[0]?.message || {};
  return {
    provider,
    model: data.model || body.model,
    text: msg.content || '',
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function?.name,
      arguments: safeJson(c.function?.arguments),
    })),
    raw: data,
  };
}

function defaultModel(provider) {
  return ({
    openai: 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
    groq: 'llama-3.1-8b-instant',
    openrouter: 'openai/gpt-4o-mini',
    mistral: 'mistral-small-latest',
    xai: 'grok-2-latest',
    ollama: 'llama3.1',
    lmstudio: 'local-model',
    local: 'local-model',
  })[provider] || 'gpt-4o-mini';
}

function openaiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  };
}

async function geminiChat({ key, model, system, messages, tools, json, timeoutMs = 0 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const contents = [];
  for (const m of messages) {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    });
  }
  const body = {
    contents,
    generationConfig: json ? { responseMimeType: 'application/json' } : {},
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      })),
    }];
  }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const fn = parts.find((p) => p.functionCall);
  return {
    provider: 'gemini',
    model,
    text: parts.map((p) => p.text || '').join('\n').trim(),
    toolCalls: fn ? [{ id: 'gemini-1', name: fn.functionCall.name, arguments: fn.functionCall.args || {} }] : [],
    raw: data,
  };
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return { _raw: String(value || '') }; }
}

const WHY = {
  auth: 'Token bị từ chối (HTTP 401/403): sai key, key đã bị thu hồi hoặc chọn nhầm nhà cung cấp. / Token rejected: wrong key or wrong provider.',
  billing: 'Token đúng nhưng hết credit / chưa thanh toán (HTTP 402). / Out of credit.',
  rate: 'Token đúng nhưng đang bị giới hạn tốc độ (HTTP 429). Thử lại sau ít phút. / Rate limited.',
  timeout: 'Hết thời gian chờ khi gọi nhà cung cấp. Kiểm tra mạng của máy chủ Hub. / Timed out reaching the provider.',
  network: 'Máy chủ Hub không kết nối được tới nhà cung cấp (DNS/mạng/tường lửa). / Hub server cannot reach the provider.',
  server: 'Nhà cung cấp đang lỗi tạm thời (HTTP 5xx). / Provider temporarily down.',
  other: 'Không xác minh được token. / Could not verify the token.',
};

/**
 * Verify a token the way Builder does: 1) list models, 2) if the list is unavailable, send a tiny real chat request.
 * Never throws. Result: { ok, verified, provider, models, kind, warning, hint }
 *  - ok:true  = token works (verified:true) – models are real (listed) or suggested (verified by a chat ping)
 *  - ok:false = token does not work or provider unreachable; `warning` says exactly why
 */
export async function verifyProvider({ provider, apiKey = '', baseUrl = '', model = '', fetchImpl, chat = completeChat } = {}) {
  const id = String(provider || '').toLowerCase();
  const local = isLocalProvider(id);
  const suggested = modelsFor(id);
  const hintFor = (kind) => (kind === 'auth' && id === 'openai' ? ' Key bắt đầu bằng "sk-" cũng có thể là DeepSeek — hãy thử chọn DeepSeek. / "sk-" keys are also used by DeepSeek.' : '');
  const det = await discoverModelsDetailed({ provider: id, apiKey, baseUrl, fetchImpl });
  if (det.ok) return { ok: true, verified: true, provider: id, models: det.models, kind: 'ok', warning: '', hint: '' };
  if (det.kind === 'auth' || det.kind === 'billing') {
    return { ok: false, verified: false, provider: id, models: suggested, kind: det.kind, warning: (WHY[det.kind] || WHY.other) + hintFor(det.kind) + (det.detail ? ` [${det.detail}]` : ''), hint: '' };
  }
  // The list endpoint is missing / empty / unreachable. A chat ping tells whether the token itself works.
  try {
    const m = model || suggested[0];
    await chat({ provider: id, model: m, apiKey, baseUrl, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], temperature: 0, timeoutMs: 25000 });
    return { ok: true, verified: true, provider: id, models: suggested, kind: 'chat_ok', warning: '', hint: 'Nhà cung cấp không liệt kê model, nhưng token chạy được (đã thử chat). Dùng danh sách gợi ý. / Listing unavailable; token works via chat test.' };
  } catch (err) {
    const msg = String(err?.message || err);
    const status = Number((msg.match(/HTTP\s+(\d+)/i) || [])[1] || 0);
    const kind = status ? discoveryErrorKindFromStatus(status) : (/abort|timeout/i.test(msg) ? 'timeout' : (local ? 'network' : (det.kind === 'network' || det.kind === 'timeout' ? det.kind : 'network')));
    if (!local && status === 404) {
      // key accepted, suggested model name just unknown on this account
      return { ok: true, verified: false, provider: id, models: suggested, kind: 'model_unknown', warning: 'Token có vẻ hợp lệ nhưng không thử được model gợi ý. Chọn model khác hoặc để trống. / Key looks valid; suggested model not available.', hint: '' };
    }
    return { ok: false, verified: false, provider: id, models: suggested, kind, warning: (WHY[kind] || WHY.other) + hintFor(kind) + ` [${(det.detail || msg).slice(0, 140)}]`, hint: '' };
  }
}

function discoveryErrorKindFromStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  return 'other';
}
