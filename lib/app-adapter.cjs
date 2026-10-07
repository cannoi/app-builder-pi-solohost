'use strict';
module.exports = {
  knowledge: `
App Builder — Pi SoloHost (Pi Network).
Help users create, test, repair, and publish SoloHost apps.

Reply in the user's language (Vietnamese or English). Keep answers short.

WHAT THIS APP DOES
- Turn an idea into a working SoloHost app (main chat).
- ▶ Run: safe local preview.
- Improve: repair from user feedback.
- 🚀 Publish: needs successful Run + GitHub owner + token in top ⚙ Settings.
- Robot panel: guide chat, Feedback Hub notices, optional extra AI key, logs.

UI
- Main chat = build/improve (uses coding AI from ⚙ Settings).
- Robot FAB = this assistant (uses coding AI automatically if panel has no key).
- Panel calls same-origin /api/ai/* (CORS + cookies enabled).
- ⚙ Settings = GitHub token + coding AI providers (Gemini, DeepSeek, Custom/Personal AI Hub as a *provider*, not this product's identity).

IMPORTANT
- This product is App Builder, NOT "Personal AI Hub".
- Personal AI Hub may be used only as an optional Custom provider base URL.
- Never ask for wallet seeds or private keys.
- Publish without GitHub token is blocked on purpose.
`,

  actions: [
    { name: 'open_builder_settings', description: 'Open top Settings for GitHub and coding AI.' },
    { name: 'explain_publish', description: 'Explain Publish requirements.' },
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
    const vi = /[àáạảãâăèéêìíòóôơùúưýăđ]|bạn|tôi|không|xin chào|chào|làm gì|ứng dụng/.test(raw);

    if (/^(xin\s*)?chào|hello|hi\b|hey\b|alo/.test(m.trim())) {
      return vi
        ? 'Xin chào! Tôi là trợ lý App Builder — Pi SoloHost. Mô tả ý tưởng app ở chat chính để Build, bấm ▶ Run xem preview, cấu hình GitHub token ở ⚙ rồi Publish. Hỏi tôi về Publish, preview hoặc Feedback.'
        : 'Hello! I am the App Builder — Pi SoloHost assistant. Describe your app in the main chat to Build, tap ▶ Run for preview, add a GitHub token in ⚙ Settings, then Publish. Ask me about Publish, preview, or Feedback.';
    }
    if (/làm gì|what.*(app|this)|app này/.test(m)) {
      return vi
        ? 'App Builder giúp bạn tạo app SoloHost cho Pi Network: mô tả ý tưởng → AI sinh code → Run thử → Improve → Publish lên GitHub/GHCR.'
        : 'App Builder helps you create SoloHost apps for Pi Network: describe an idea → AI generates code → Run → Improve → Publish to GitHub/GHCR.';
    }
    if (/publish|xuất bản|github/.test(m)) {
      return vi
        ? 'Publish cần: (1) ▶ Run OK, (2) ⚙ Settings → GitHub owner + token → Save, (3) 🚀 Publish. Thiếu token sẽ bị chặn.'
        : 'Publish needs: (1) successful Run, (2) ⚙ Settings → GitHub owner + token → Save, (3) 🚀 Publish. Missing token blocks Publish.';
    }
    if (/preview|run|chạy/.test(m)) {
      return vi
        ? 'Bấm ▶ Run để mở preview an toàn. Lỗi thì mô tả trong chat chính để Improve.'
        : 'Tap ▶ Run for a safe preview. If it fails, describe the issue in the main chat to Improve.';
    }
    if (/feedback|góp ý/.test(m)) {
      return vi
        ? 'Tab Feedback trên panel robot: gửi góp ý và đọc thông báo Hub. Badge chỉ hiện khi còn thông báo chưa đọc.'
        : 'Feedback tab on the robot panel: send feedback and read Hub notices. Badge shows only when unread notices exist.';
    }
    if (/ai|model|key|token|provider/.test(m)) {
      return vi
        ? 'AI coding cấu hình ở ⚙ Settings trên cùng. Panel robot dùng chung AI đó nếu bạn chưa dán key riêng trong panel Settings.'
        : 'Coding AI is configured in top ⚙ Settings. The robot panel reuses that AI when you have not set a separate panel key.';
    }
    return vi
      ? 'Hướng dẫn offline App Builder — Pi SoloHost. Thêm AI ở ⚙ Settings để chat đầy đủ. Hỏi về build, Run, Publish hoặc Feedback.'
      : 'Offline guide for App Builder — Pi SoloHost. Add AI in ⚙ Settings for full chat. Ask about build, Run, Publish, or Feedback.';
  },
};
