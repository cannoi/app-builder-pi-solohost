export const PROVIDER_CATALOG = [
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com', discover: true, fallbackModels: ['deepseek-v4-flash', 'deepseek-chat'] },
  { id: 'gemini', name: 'Google Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', discover: true, fallbackModels: [] },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', discover: true, fallbackModels: ['gpt-4.1-mini', 'gpt-4o-mini'] },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', discover: false, fallbackModels: ['claude-sonnet-4-5', 'claude-3-5-haiku-latest'] },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', discover: true, fallbackModels: ['openrouter/auto'] },
  { id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', discover: true, fallbackModels: ['llama-3.3-70b-versatile'] },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', discover: true, fallbackModels: ['mistral-small-latest'] },
  { id: 'xai', name: 'xAI', kind: 'openai', baseUrl: 'https://api.x.ai/v1', discover: true, fallbackModels: ['grok-4', 'grok-3-mini'] },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai', baseUrl: '', discover: true, fallbackModels: [] },
];

export function catalogEntry(id) {
  return PROVIDER_CATALOG.find((p) => p.id === id) || null;
}

export function taskComplexity(task = '') {
  const t = String(task || '').toUpperCase();
  if (['CODING', 'DEBUGGING', 'ARCHITECTURE', 'SECURITY'].includes(t)) return 'high';
  if (['CODE_REVIEW', 'TEST_GENERATION', 'PRODUCT_PLANNING'].includes(t)) return 'medium';
  return 'low';
}
