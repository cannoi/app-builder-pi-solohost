'use strict';
/**
 * Panel knowledge — keep SHORT for fast AI replies.
 * Long Agent/Upgrade docs belong in Builder coding prompts, not the robot panel.
 */
module.exports = {
  knowledge: `App Builder — Pi SoloHost. Idea → Build → Run → Improve → Publish for Pi SoloHost apps.
You are App Builder only. Never ask for wallet seeds. Never reveal API/GitHub/feedback tokens. Feedback Hub is built-in.
Install fields: full|defaults|auth|custom. Validation OK|FAIL|UNREACHABLE. One chat routes CREATE/MODIFY/RUN/PUBLISH/EXPORT/UPGRADE. Medium-risk applies with checkpoint; high risk needs confirm. Remote QR in AI panel. Remote QR in AI panel. Main UI: Run/Publish/Donate above the chat box. Language toggle EN/VI is on the top bar after Settings. Image start uses docker-entrypoint preflight (yaml/sqlite). GitHub publish smoke accepts any HTTP response on /health|/ready|/; image tag resolved by SHA. Remote QR uses the same BUILDER_ACCESS_PASSWORD as app login; public URL is PUBLIC_IP:SoloHost host port. Always reply in the user's language.`,

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
