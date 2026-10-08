'use strict';
/**
 * Panel knowledge — keep SHORT for fast AI replies.
 * Long Agent/Upgrade docs belong in Builder coding prompts, not the robot panel.
 */
module.exports = {
  knowledge: `App Builder — Pi SoloHost (Pi Network).
Help users Build / Run / Improve / Publish SoloHost apps. Reply in the user's language (VI or EN). Be short.
Flow: describe idea → Build → ▶ Run → Improve → 🚀 Publish (needs GitHub owner+token in ⚙ Settings).
Robot panel uses /api/panel/chat → same AIGateway as Settings (Gemini etc.) — one key only. Not a second local provider.
Settings: choose Provider + paste key → ↻ Load models (fetches from that API) → type or pick Model → ＋ Add. Model field accepts manual id.
Upgrade: import/re-import ZIP accepts files; Publish syncs SoloHost docker-compose.yml + config_options.yml (copy cards).
Feedback tab = Hub notices. Never ask for wallet seeds. Never invent Publish success.
You are App Builder, not Personal AI Hub (PAH is only an optional Custom provider).`,

  actions: [
    { name: 'open_builder_settings', description: 'Open Settings for GitHub and AI.' },
    { name: 'explain_publish', description: 'Explain Publish steps.' },
    { name: 'explain_preview', description: 'Explain Run/preview.' },
    { name: 'explain_feedback', description: 'Explain Feedback tab.' },
  ],

  async getContext(ctx) {
    return { app: 'App Builder — Pi SoloHost', surface: 'robot-panel', ...(ctx || {}) };
  },

  async executeAction({ name }) {
    const allowed = ['open_builder_settings', 'explain_publish', 'explain_preview', 'explain_feedback'];
    if (!allowed.includes(name)) return { ok: false, error: 'Action not allowed' };
    return { ok: true, action: name };
  },

  async localReply(message) {
    const raw = String(message || '');
    const m = raw.toLowerCase();
    const vi = /[àáạảãâăèéêìíòóôơùúưýăđ]|bạn|tôi|không|xin chào|làm gì|ứng dụng|là sao/.test(raw);

    if (/^(xin\s*)?chào|hello|hi\b|hey\b|alo/.test(m.trim()) || /app (này |gì)|làm gì/.test(m)) {
      return vi
        ? 'Xin chào! App Builder — Pi SoloHost. Mô tả app ở chat chính để Build/Run/Publish. AI cấu hình một lần ở ⚙ Settings.'
        : 'Hello! App Builder — Pi SoloHost. Describe your app in the main chat to Build/Run/Publish. Configure AI once in ⚙ Settings.';
    }
    if (/publish|xuất bản|github/.test(m)) {
      return vi
        ? 'Publish: (1) Run OK, (2) ⚙ Settings → GitHub owner + token, (3) 🚀 Publish. Sau đó copy 2 file SoloHost (compose + config_options).'
        : 'Publish: (1) Run OK, (2) GitHub owner + token in ⚙ Settings, (3) 🚀 Publish. Then copy the two SoloHost files.';
    }
    if (/preview|run|chạy|sandbox/.test(m)) {
      return vi
        ? 'Bấm ▶ Run để xem trước. Lỗi thì mô tả trong chat chính để Improve.'
        : 'Tap ▶ Run for a preview. If it fails, describe the issue in the main chat to Improve.';
    }
    if (/ai|key|provider|cấu hình|settings|panel|chậm|slow/.test(m)) {
      return vi
        ? 'AI một lần ở ⚙ Settings (Gemini/DeepSeek/Custom). Panel robot dùng chung — không nhập key lần hai.'
        : 'Configure AI once in ⚙ Settings (Gemini/DeepSeek/Custom). The robot panel shares it — no second key.';
    }
    if (/solohost|compose|config_options|cài đặt/.test(m)) {
      return vi
        ? 'Sau Publish: copy docker-compose.yml và config_options.yml vào SoloHost → Lưu → Start (hoặc tải ZIP SoloHost).'
        : 'After Publish: copy docker-compose.yml and config_options.yml into SoloHost → Save → Start (or download the SoloHost ZIP).';
    }
    return vi
      ? 'Hỏi về Build, Run, Publish, GitHub token, Feedback hoặc SoloHost install.'
      : 'Ask about Build, Run, Publish, GitHub token, Feedback, or SoloHost install.';
  },
};
