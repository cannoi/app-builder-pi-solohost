/**
 * Single source of app facts for Panel + Builder AI knowledge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function pkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'));
  } catch {
    return { name: 'Quick actions: Run/Publish/Donate use data-action→quick(). Welcome shows on New app. More menu labels single icon. Playwright optional for Run. App Builder', version: '0.0.0' };
  }
}

const p = pkg();

export const APP_FACTS = {
  name: 'App Builder — Pi SoloHost',
  version: p.version,
  languages: ['en', 'vi'],
  installFieldModes: ['full', 'defaults', 'auth', 'custom'],
  validationStatuses: ['OK', 'FAIL', 'UNREACHABLE'],
  acceptUnverified: true,
  needsFieldChoice: true,
  packagePendingResume: true,
  stableHostPortRange: '18000-18999',
  feedbackBuiltIn: true,
  feedbackUserEntersNothing: true,
  chatInUserLanguage: true,
};

/** Core panel knowledge always sent (<700 chars). */
export function coreKnowledge(locale = 'en') {
  const v = APP_FACTS.version;
  if (locale === 'vi') {
    return (
      `App Builder — Pi SoloHost v${v}. Tạo app SoloHost cho Pi Network: Ý tưởng → Build → Run → Improve → Publish.\n` +
      `Không phải Personal AI Hub hay app khác. Không xin seed ví / khóa. Feedback Hub đã gắn sẵn — người dùng không nhập hub.\n` +
      `Publish: chọn install fields (full/defaults/auth/custom). Validator: OK|FAIL|UNREACHABLE (có thể accept unverified).\n` +
      `Trả lời bằng ngôn ngữ người dùng. Preview banner sau 20s.`
    ).slice(0, 700);
  }
  return (
    `App Builder — Pi SoloHost v${v}. Help users build SoloHost apps: Idea → Build → Run → Improve → Publish.\n` +
    `You are App Builder, not Personal AI Hub or another product. Never ask for wallet seeds or reveal API/GitHub/feedback tokens.\n` +
    `Publish uses install-field modes full|defaults|auth|custom. Validation: OK|FAIL|UNREACHABLE (accept unverified possible).\n` +
    `Questions never publish. Optional Change Engine V2 (CHANGE_ENGINE_V2) uses search/replace for MODIFY. Medium-risk edits apply with checkpoint; high risk needs one confirm. Remote access QR in AI panel. Main UI: Run/Publish/Donate above the chat box. Language toggle EN/VI is on the top bar after Settings. Image start uses docker-entrypoint preflight (yaml/sqlite). GitHub publish smoke accepts any HTTP response on /health|/ready|/; image tag resolved by SHA. Remote QR uses the same BUILDER_ACCESS_PASSWORD as app login; public URL is PUBLIC_IP:SoloHost host port. Always reply in the user's language. One chat box routes CREATE/MODIFY/PUBLISH/UPGRADE. Remote QR in AI panel. Preview notice after 20s.`
  ).slice(0, 700);
}

const MODULES = {
  publish: 'Publish: GitHub → GHCR image → SoloHost kit (docker-compose.yml + config_options.yml). needs_field_choice before kit for new apps; upgrade-origin defaults to full. Resume via release-pending package_pending without second push.',
  'install-fields': 'Install fields: full (all questions), defaults (omit most), auth (login only), custom (per-var keep|fixed|omit). Internal vars never in the form. Secrets never in fixed_values.',
  validation: 'SoloHost validation: offline lint then remote. FAIL blocks. UNREACHABLE needs acceptUnverified confirmation. Status chip OK|FAIL|UNREACHABLE.',
  preview: 'Preview is limited (main page, no Internet). Real test: Run ZIP on PC or Publish Unlisted. Limited-preview note shows after 20 seconds.',
  upgrade: 'Upgrade is separate from Build. Upgrade changes behavior; Build validates/repairs; Publish produces deployment artifacts (config_options.yml, pi.ui.primary).',
  feedback: 'Feedback Hub is built in (nothing to enter). Server posts to hub; browser never sees ingest token. If hub down, Feedback tab shows localized offline message.',
  language: 'UI languages: English and Vietnamese. Chat replies always follow the user language.',
  troubleshooting: 'If AI fails: check Settings provider+key, Load models, GitHub token before Publish. Prefer Diagnose & Fix with logs over restarting from scratch.',
};

export function topicKnowledge(message = '', history = []) {
  const text = `${message}\n${(history || []).map((h) => h.content || '').join('\n')}`.toLowerCase();
  const picked = [];
  const rules = [
    [/publish|ghcr|github|solohost kit|xuất bản/, 'publish'],
    [/field|install form|config_options|full form|login only|custom/, 'install-fields'],
    [/validat|lint|unreachable|fail|ok\b/, 'validation'],
    [/preview|sandbox|run zip|chạy thử/, 'preview'],
    [/upgrade|nâng cấp|dare|repair/, 'upgrade'],
    [/feedback|hub|góp ý/, 'feedback'],
    [/language|tiếng|english|vietnamese|việt/, 'language'],
    [/error|lỗi|fix|token|key|settings/, 'troubleshooting'],
  ];
  for (const [re, key] of rules) {
    if (re.test(text) && !picked.includes(key)) picked.push(key);
  }
  if (!picked.length) picked.push('troubleshooting');
  let out = '';
  for (const k of picked) {
    const chunk = MODULES[k];
    if (!chunk) continue;
    if ((out + chunk).length > 1800) break;
    out += (out ? '\n' : '') + chunk;
  }
  return out;
}

export function panelKnowledge({ message = '', history = [], locale = 'en' } = {}) {
  const core = coreKnowledge(locale);
  const topics = topicKnowledge(message, history);
  const combined = `${core}\n---\n${topics}`;
  return combined.length > 2500 ? combined.slice(0, 2500) : combined;
}

export function builderKnowledge() {
  return [
    `App Builder — Pi SoloHost v${APP_FACTS.version}.`,
    'Upgrade is separate from Build.',
    'Publish produces the deployment artifact the user will run (docker-compose.yml + config_options.yml).',
    'SoloHost needs pi.ui.primary on exactly one service and a loopback port.',
    'Install field modes: full, defaults, auth, custom (keep|fixed|omit).',
    'Always reply in the user language. Never reveal secrets or the feedback ingest token.',
  ].join('\n');
}

export default { APP_FACTS, coreKnowledge, topicKnowledge, panelKnowledge, builderKnowledge };
