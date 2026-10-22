/**
 * Complexity router: trivial → fast path; complex → orchestrator.
 * Signals matter more than single keywords (login alone ≠ complex).
 */
const STRONG = [
  /\b(multiplayer|websocket|socket\.io|webrtc)\b/i,
  /\b(migrate|schema change|postgres|mongodb)\b/i,
  /\b(oauth|jwt auth|sso)\b/i,
  /\b(refactor|restructure|rewrite)\b/i,
  /\b(lan multiplayer|chơi mạng|nhiều người|đồng bộ phòng)\b/i,
];
const WEAK = [
  /\b(auth|login|database|docker|lan|sse)\b/i,
  /\b(add|thêm).{0,40}(route|api|screen|page|module|dependency|package)\b/i,
];

export function classifyComplexity({ request = '', filesTouchedHint = 0, newDep = false, contractChange = false } = {}) {
  const text = String(request || '');
  const signals = [];
  if (newDep) signals.push('new_dependency');
  if (contractChange) signals.push('contract_change');
  if (filesTouchedHint >= 3) signals.push('many_files');
  for (const re of STRONG) {
    if (re.test(text)) signals.push('strong:' + re.source.slice(0, 24));
  }
  let weakHits = 0;
  for (const re of WEAK) {
    if (re.test(text)) weakHits += 1;
  }
  if (weakHits >= 2) signals.push('weak_combo');

  const complex =
    signals.includes('new_dependency') ||
    signals.includes('contract_change') ||
    filesTouchedHint >= 3 ||
    signals.some((s) => s.startsWith('strong:')) ||
    (weakHits >= 2 && filesTouchedHint >= 2);

  return {
    level: complex ? 'complex' : 'trivial',
    signals,
    reason: complex ? 'multi-file or platform-sensitive request' : 'small focused edit',
  };
}
