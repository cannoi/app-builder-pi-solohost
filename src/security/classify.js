/**
 * Secret / credential classification for SoloHost App Builder.
 * Notices and warnings must not become operation-blocking gates
 * unless the finding is a high-impact real secret with high confidence.
 */

const REAL_PROVIDER = /\b(AIza[0-9A-Za-z\-_]{20,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const PRIVATE_KEY = /BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY/;
const WALLET = /\b(seed phrase|mnemonic|0x[a-fA-F0-9]{64}|wallet[_-]?secret)\b/i;

const USER_CONFIG_NAMES = /\b(HUB_ID|SHFH_HUB_ID|APP_ID|SHFH_APP_ID|PUBLIC_BASE_URL|PREVIEW_PUBLIC_BASE_URL|INGEST_TOKEN|SHFH_INGEST_TOKEN|APP_TOKEN|CLIENT_TOKEN|CUSTOM_PASSWORD|INTERNAL_ID|FEEDBACK_APP_ID)\b/i;
const EXAMPLE_CTX = /(\.example|\.sample|\.template|example|placeholder|changeme|your[_-]?token|xxx+|TODO)/i;
const TEST_CTX = /(test|fixture|mock|dummy|sample)/i;

export function classifyCredentialSnippet({ text = '', file = '', name = '' } = {}) {
  const s = String(text || '');
  const f = String(file || '');
  const n = String(name || '');
  const combined = `${n}\n${f}\n${s}`;

  if (PRIVATE_KEY.test(s)) {
    return {
      class: 'PRIVATE_KEY',
      severity: 'critical',
      confidence: 'high',
      operationImpact: 'BLOCK_PUBLIC_RELEASE',
      title: 'Private key material detected in source.',
    };
  }
  if (WALLET.test(s)) {
    return {
      class: 'WALLET_SECRET',
      severity: 'critical',
      confidence: 'high',
      operationImpact: 'BLOCK_PUBLIC_RELEASE',
      title: 'Wallet or seed material may be embedded in source.',
    };
  }
  if (REAL_PROVIDER.test(s) && !EXAMPLE_CTX.test(combined) && !TEST_CTX.test(f)) {
    return {
      class: 'REAL_SECRET',
      severity: 'critical',
      confidence: 'high',
      operationImpact: 'BLOCK_PUBLIC_RELEASE',
      title: 'Provider API key pattern detected in source.',
    };
  }
  if (USER_CONFIG_NAMES.test(combined) || USER_CONFIG_NAMES.test(s)) {
    return {
      class: 'USER_DEFINED_CONFIGURATION',
      severity: 'notice',
      confidence: 'high',
      operationImpact: 'CONTINUE',
      title: 'User-defined Hub/app configuration value preserved.',
    };
  }
  if (EXAMPLE_CTX.test(combined) || /\.env\.example$/i.test(f) || /\.md$/i.test(f)) {
    return {
      class: 'EXAMPLE_VALUE',
      severity: 'notice',
      confidence: 'medium',
      operationImpact: 'CONTINUE',
      title: 'Example or documentation credential pattern (not blocking).',
    };
  }
  if (TEST_CTX.test(f) || TEST_CTX.test(combined)) {
    return {
      class: 'TEST_FIXTURE',
      severity: 'notice',
      confidence: 'medium',
      operationImpact: 'CONTINUE',
      title: 'Test fixture credential pattern (not blocking).',
    };
  }
  if (/\b(token|secret|password|api[_-]?key)\b/i.test(s) && /[=:]\s*['"][^'"]{8,}/.test(s)) {
    return {
      class: 'SENSITIVE_CREDENTIAL',
      severity: 'warning',
      confidence: 'medium',
      operationImpact: 'CONTINUE_WITH_WARNING',
      title: 'Possible hard-coded credential — review recommended.',
    };
  }
  return {
    class: 'UNKNOWN',
    severity: 'notice',
    confidence: 'low',
    operationImpact: 'CONTINUE',
    title: 'Unclassified credential-like text.',
  };
}

export function isBlockingSecurityFinding(finding) {
  if (!finding) return false;
  if (finding.operationImpact === 'BLOCK_PUBLIC_RELEASE') return true;
  if (finding.severity === 'critical' && ['PRIVATE_KEY', 'WALLET_SECRET', 'REAL_SECRET', 'DOCKER_SOCKET', 'PRIVILEGED'].includes(finding.class)) {
    return true;
  }
  return false;
}
