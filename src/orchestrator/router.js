/**
 * Complexity router: trivial → fast path; complex → orchestrator.
 */
const COMPLEX_RE = [
  /\b(multiplayer|websocket|socket\.io|webrtc|sse)\b/i,
  /\b(database|schema|migrate|sqlite|postgres)\b/i,
  /\b(auth|login|oauth|jwt)\b/i,
  /\b(docker|compose|config_options|host.?port|lan)\b/i,
  /\b(add|thêm).{0,40}(route|api|screen|page|module|dependency|package)\b/i,
  /\b(refactor|restructure|rewrite)\b/i,
];

export function classifyComplexity({ request = '', filesTouchedHint = 0, newDep = false, contractChange = false } = {}) {
  const text = String(request || '');
  const signals = [];
  if (newDep) signals.push('new_dependency');
  if (contractChange) signals.push('contract_change');
  if (filesTouchedHint > 2) signals.push('many_files');
  for (const re of COMPLEX_RE) {
    if (re.test(text)) signals.push(re.source.slice(0, 40));
  }
  // Vietnamese multi-word
  if (/chơi mạng|nhiều người|phòng chờ|lobby|đồng bộ/i.test(text)) signals.push('vi_multiplayer');
  if (/cổng|mạng lan|thiết bị khác/i.test(text)) signals.push('vi_lan');

  const complex = signals.length >= 1 && (
    signals.includes('new_dependency') ||
    signals.includes('contract_change') ||
    filesTouchedHint > 2 ||
    /multiplayer|websocket|lan|lobby|đồng bộ|chơi mạng/i.test(text) ||
    signals.length >= 2
  );
  return {
    level: complex ? 'complex' : 'trivial',
    signals,
    reason: complex ? 'multi-file or platform-sensitive request' : 'small focused edit',
  };
}
