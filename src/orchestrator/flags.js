/** Orchestrator V3 — Plan → Execute → Verify → Repair → Replan */
export function isOrchestratorV3Enabled(env = process.env) {
  const v = String(env.ORCHESTRATOR_V3 ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}
