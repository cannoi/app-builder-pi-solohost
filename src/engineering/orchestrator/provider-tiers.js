/**
 * Provider tiers (v1.10.0, M1).
 *  A — reliable JSON/tool use: may issue tool actions (several per turn, still read-only + bounded)
 *  B — usable JSON: one tool action per turn
 *  C — local / Ollama / small models: NO tool selection; evidence injection only
 * The decision is stored per model in engineering-context.json; switching provider keeps the context.
 */
export const TIERS = Object.freeze({ A: 'A', B: 'B', C: 'C' });

const TIER_A = /(gpt-4|gpt-5|o[134]-|claude-(3\.5|3-5|3-7|4|opus|sonnet)|gemini-(2\.5|3)|deepseek-(v3|v4|chat|reasoner))/i;
const TIER_C = /(ollama|llama|mistral|phi|qwen.*(0\.5|1\.5|3b|7b)|gemma|tinyllama|local|lm-?studio|:\d+b\b|-\d+b\b)/i;

export function providerTier({ provider = '', model = '' } = {}) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (p === 'ollama' || p === 'local' || p === 'lmstudio' || TIER_C.test(m) && !TIER_A.test(m)) return TIERS.C;
  if (TIER_A.test(m) || (['gemini', 'deepseek', 'openai', 'anthropic'].includes(p) && !m)) return TIERS.A;
  return TIERS.B;
}

export function tierPolicy(tier) {
  if (tier === TIERS.A) return { tier, toolActions: true, maxActionsPerTurn: 4, evidence: true };
  if (tier === TIERS.B) return { tier, toolActions: true, maxActionsPerTurn: 1, evidence: true };
  return { tier: TIERS.C, toolActions: false, maxActionsPerTurn: 0, evidence: true };
}

/** Apply a tier to a batch of model-proposed actions (never widens permissions). */
export function limitActionsForTier(actions = [], tier) {
  const pol = tierPolicy(tier);
  if (!pol.toolActions) return [];
  return (Array.isArray(actions) ? actions : []).slice(0, pol.maxActionsPerTurn);
}

/** Record the tier decision for a model inside the engineering context (pure; caller saves). */
export function withTierDecision(context = {}, { provider, model }) {
  const tier = providerTier({ provider, model });
  const key = `${provider || 'unknown'}:${model || 'default'}`;
  const decisions = { ...(context.providerTiers || {}), [key]: { tier, decidedAt: new Date().toISOString() } };
  return { ...context, providerTiers: decisions, activeProvider: key };
}
