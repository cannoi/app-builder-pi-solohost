Remote link like Snake Arcade: learn host port from request Host header; public IP via ipify; URL http://IP:hostPort. Remote QR auto-detects public IP and SoloHost HOST_PORT (http://IP:PORT); PUBLIC_URL overrides.
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
export function coreKnowledge(lang = 'en') {
  if (lang === 'vi') {
    return 'App Builder — Pi SoloHost: một ô chat tạo/sửa/chạy/xuất bản app SoloHost. Nút ▶ Chạy thử, 🚀 Xuất bản, 💛 Ủng hộ. Menu ⋯: ZIP, nhập ZIP, Sandbox, hoàn tác. Mặc định New app + hướng dẫn. AI trả lời theo ngôn ngữ tin nhắn. Publish cần GitHub token; AI cần key trong Settings.';
  }
  return 'App Builder — Pi SoloHost: one chat to create, fix, run, and publish SoloHost apps. Buttons: ▶ Run, 🚀 Publish, 💛 Donate. Menu ⋯: ZIP, import, Sandbox, undo. Default New app + welcome. AI replies in the user message language. Publish needs a GitHub token; AI needs a provider key in Settings.';
}


const MODULES = {
  publish: 'Publish: GitHub → GHCR image → SoloHost