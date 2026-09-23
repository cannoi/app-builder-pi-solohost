export const PROVIDER_CATALOG = [
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', discover: true },
  { id: 'gemini', name: 'Google Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', discover: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com', discover: true },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', discover: true },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', discover: true },
  { id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', discover: true },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', discover: true },
  { id: 'xai', name: 'xAI', kind: 'openai', baseUrl: 'https://api.x.ai/v1', discover: true },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai', baseUrl: '', discover: true },
];

export function catalogEntry(id) { return PROVIDER_CATALOG.find((p) => p.id === id) || null; }

export function taskComplexity(task = '') {
  const t = String(task || '').toUpperCase();
  if (['CODING', 'DEBUGGING', 'ARCHITECTURE', 'SECURITY', 'PROJECT_ANALYSIS'].includes(t)) return 'high';
  if (['CODE_REVIEW', 'TEST_GENERATION', 'PRODUCT_PLANNING', 'IDEA_ANALYSIS'].includes(t)) return 'medium';
  return 'low';
}
