export const PROVIDER_CATALOG = [
  { id: 'gemini', name: 'Google Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', discover: true },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', discover: true },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', discover: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com', discover: true },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', discover: true },
  { id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', discover: true },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', discover: true },
  { id: 'xai', name: 'xAI', kind: 'openai', baseUrl: 'https://api.x.ai/v1', discover: true },
  { id: 'together', name: 'Together AI', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', discover: true },
  { id: 'fireworks', name: 'Fireworks AI', kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', discover: true },
  { id: 'cerebras', name: 'Cerebras', kind: 'openai', baseUrl: 'https://api.cerebras.ai/v1', discover: true },
  { id: 'perplexity', name: 'Perplexity', kind: 'openai', baseUrl: 'https://api.perplexity.ai', discover: true },
  { id: 'nvidia', name: 'NVIDIA NIM', kind: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', discover: true },
  { id: 'cohere', name: 'Cohere', kind: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', discover: true },
  { id: 'qwen', name: 'Alibaba Qwen (DashScope)', kind: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', discover: true },
  { id: 'ollama', name: 'Ollama (Local)', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', discover: true, fallbackModels: ['auto'] },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai', baseUrl: '', discover: true, fallbackModels: ['auto'] },
];

export function catalogEntry(id) { return PROVIDER_CATALOG.find((p) => p.id === id) || null; }

export function taskComplexity(task = '') {
  const t = String(task || '').toUpperCase();
  // 1.8.13: idea/plan/code are product-critical — prefer high complexity routing
  if (['CODING', 'DEBUGGING', 'ARCHITECTURE', 'SECURITY', 'PROJECT_ANALYSIS', 'PRODUCT_PLANNING', 'IDEA_ANALYSIS'].includes(t)) return 'high';
  if (['CODE_REVIEW', 'TEST_GENERATION'].includes(t)) return 'medium';
  return 'low';
}
