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
    return { name: 'app-builder-pi-solohost', version: '0.0.0' };
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
export function coreKnowledge(lang = 'en') {
  if (lang === 'vi') {
    return 'App Builder — Pi SoloHost: một ô chat tạo/sửa/chạy/xuất bản app SoloHost. AI: Gemini mặc định; hỗ trợ DeepSeek/Custom/Personal AI Hub. Chọn model hoặc để auto. Nút ▶ Chạy thử, 🚀 Xuất bản, 💛 Ủng hộ. Menu ⋯: ZIP, nhập ZIP, Sandbox, hoàn tác. Mặc định New app + hướng dẫn. AI trả lời theo ngôn ngữ tin nhắn. Publish cần GitHub token; AI cần key trong Settings.';
  }
  return 'App Builder — Pi SoloHost: one chat to create, fix, run, and publish SoloHost apps. AI: Gemini default; DeepSeek/Custom/Personal AI Hub also supported. Pick a model or leave auto. Buttons: ▶ Run, 🚀 Publish, 💛 Donate. Menu ⋯: ZIP, import, Sandbox, undo. Default New app + welcome. AI replies in the user message language. Publish needs a GitHub token; AI needs a provider key in Settings.';
}


const MODULES = {
  publish: 'Publish: GitHub → GHCR image → SoloHost kit (docker-compose.yml + config_options.yml). needs_field_choice before kit for new apps; upgrade-origin defaults to full. Resume via release-pending package_pending without second push.',
  'install-fields': 'Install fields: full (all questions), defaults (omit most), auth (login only), custom (per-var keep|fixed|omit). Internal vars never in the form. Secrets never in fixed_values.',
  validation: 'SoloHost validation: offline lint then remote. FAIL blocks. UNREACHABLE needs acceptUnverified confirmation. Status chip OK|FAIL|UNREACHABLE.',
  preview: 'Preview is limited (main page, no Internet). Real test: Run ZIP on PC or Publish Unlisted. Limited-preview note shows after 20 seconds.',
  upgrade: 'Upgrade is separate from Build. Upgrade changes behavior; Build validates/repairs; Publish produces deployment artifacts (config_options.yml, pi.ui.primary).',
  feedback: 'Feedback Hub is built in (nothing to enter). Server posts to hub; browser never sees ingest token. If hub down, Feedback tab shows localized offline message. Feedback tab is on the robot AI panel.',
  language: 'UI languages: English and Vietnamese. Chat replies always follow the user language.',
  orchestrator: 'Complex multi-file requests use Orchestrator V3: plan → execute → verify → repair. Feasibility conflicts (e.g. LAN vs 127.0.0.1) ask once.',
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
