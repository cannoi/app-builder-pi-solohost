const ALLOWED = [
  { id: 'npm_test', re: /^npm(\s+run)?\s+test\b/ },
  { id: 'npm_build', re: /^npm(\s+run)?\s+build\b/ },
  { id: 'node_test', re: /^node\s+--test\b/ },
  { id: 'docker_build', re: /^docker\s+build\b/ },
  { id: 'docker_compose', re: /^docker\s+compose\b/ },
  { id: 'git_status', re: /^git\s+(status|log|diff)\b/ },
];

const BLOCKED = [
  /\brm\s+-rf\s+\/\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bcurl\s+[^\n]*\|\s*(sh|bash)/,
  /\bcat\s+\/etc\/shadow\b/,
  /\b\/root\/\.ssh\b/,
  /\bdocker\s+run[^\n]*--privileged\b/,
  /\bdocker\.sock\b/,
];

export function classifyAction(action) {
  const safe = new Set([
    'read_project', 'analyze', 'generate_code', 'modify_files',
    'run_tests', 'create_snapshot', 'generate_docs',
  ]);
  const confirm = new Set([
    'push_github', 'publish_release', 'deploy', 'change_ports',
    'enable_docker_socket', 'delete_project', 'major_architecture',
    'apply_patch',
  ]);
  if (safe.has(action)) return 'SAFE';
  if (confirm.has(action)) return 'CONFIRM';
  return 'BLOCKED';
}

export function evaluateCommand(command, { dockerMode = 'safe' } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, reason: 'Empty command' };
  if (BLOCKED.some((re) => re.test(cmd))) {
    return { ok: false, reason: 'Command is blocked by security policy' };
  }
  if (/^docker\b/.test(cmd) && dockerMode !== 'power') {
    return { ok: false, reason: 'Docker commands require POWER mode' };
  }
  const allowed = ALLOWED.find((a) => a.re.test(cmd));
  if (!allowed) return { ok: false, reason: 'Command is not on the allowlist' };
  return { ok: true, id: allowed.id };
}
