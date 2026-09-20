import { maskKey } from '../../utils/mask.js';

export class DeepSeekProvider {
  constructor({ apiKey, model }) {
    this.name = 'deepseek';
    this.apiKey = apiKey;
    this.model = model || 'deepseek-flash';
  }

  configured() { return Boolean(this.apiKey); }

  async complete({ prompt, system, json = false, images = [] }) {
    if (!this.apiKey) throw new Error('DeepSeek API key is not configured');
    const started = Date.now();
    const userContent = [{ type: 'text', text: prompt }];
    for (const image of images || []) {
      if (!image?.dataUrl) continue;
      userContent.push({ type: 'image_url', image_url: { url: image.dataUrl } });
    }
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: json ? 0.2 : 0.4,
        response_format: json ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: system || 'You are a careful senior software architect.' },
          { role: 'user', content: userContent },
        ],
      }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${raw.slice(0, 500)}`);
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('DeepSeek returned invalid JSON'); }
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('DeepSeek returned an empty response');
    return {
      text,
      provider: this.name,
      model: this.model,
      durationMs: Date.now() - started,
      tokens: data.usage?.total_tokens ?? null,
      rawMeta: { key: maskKey(this.apiKey), imageCount: images?.length || 0 },
    };
  }
}
