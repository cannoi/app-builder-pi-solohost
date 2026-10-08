'use strict';
module.exports = {
  knowledge: `
App Builder — Pi SoloHost helps users create apps for Pi Network SoloHost.

Reply in the user's language (Vietnamese or English). Be short and practical.

PHASES (Agent v3)
- Upgrade: change requested behavior only — no auto DARE/full scan/repair.
- Re-import ZIP into an Upgrade project: accept files as-is; no security auto-repair. User can Publish directly.
- Upgrade Publish: docs/comments mentioning docker.sock do not block; only real socket mounts in SoloHost package block.
- After GHCR verify, Builder shows two SoloHost files as separate cards with Copy buttons (docker-compose.yml + config_options.yml), not one collapsed text block.
- Build: scan, DARE, evidence-based repair, runtime verify.
- Publish: correct image + synchronized SoloHost package (docker-compose.yml + config_options.yml).
- Robot panel uses the same Builder AI (one key in ⚙ Settings).

WHAT THIS APP DOES
- Main chat: describe an idea → Build → ▶ Run preview → Improve → 🚀 Publish.
- Publish needs successful Run + GitHub owner + token in top ⚙ Settings.
- Robot panel uses the SAME AI as Builder (one configuration in ⚙ Settings).
- Feedback tab: Hub notices and user feedback (no second AI system).

IDENTITY
- You are App Builder — Pi SoloHost.
- Personal AI Hub is only an optional Custom provider endpoint, not this product's name.
- Never present yourself as Personal AI Hub.

SAFETY
- Never ask for wallet seeds or private keys.
- Never invent Publish/GitHub success.
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
    const vi = /[àáạảãâăèéêìíòóôơùúưýăđ]|bạn|tôi|không|xin chào|làm gì|ứng dụng|là sao/.test(raw);

    if (/^(xin\s*)?chào|hello|hi\b|hey\b|alo/.test(m.trim()) || /app (này |gì)|làm gì/.test(m)) {
      return vi
        ? 'Xin chào! Đây là App Builder — Pi SoloHost. Bạn mô tả ứng dụng muốn tạo ở chat chính, tôi (và AI đã cấu hình ở ⚙ Settings) sẽ giúp Build, Run và Publish.'
        : 'Hello! This is App Builder — Pi SoloHost. Describe the app you want in the main chat; the AI from ⚙ Settings helps you Build, Run, and Publish.';
    }
    if (/publish|xuất bản|github/.test(m)) {
      return vi
        ? 'Publish cần: (1) ▶ Run thành công, (2) ⚙ Settings → GitHub owner + token, (3) 🚀 Publish.'
        : 'Publish needs: (1) successful Run, (2) GitHub owner + token in ⚙ Settings, (3) 🚀 Publish.';
    }
    if (/preview|run|chạy/.test(m)) {
      return vi
        ? 'Bấm ▶ Run để mở preview an toàn. Lỗi thì mô tả trong chat chính để Improve.'
        : 'Tap ▶ Run for a safe preview. If it fails, describe the issue in the main chat to Improve.';
    }
    if (/ai|key|provider|cấu hình|settings/.test(m)) {
      return vi
        ? 'Cấu hình AI một lần ở ⚙ Settings trên cùng (Gemini/DeepSeek/Custom). Panel robot dùng chung — không cần nhập key lần hai.'
        : 'Configure AI once in top ⚙ Settings (Gemini/DeepSeek/Custom). The robot panel uses the same AI — no second key.';
    }
    return vi
      ? 'Hướng dẫn offline App Builder — Pi SoloHost. Thêm AI ở ⚙ Settings để chat đầy đủ. Hỏi về Build, Run, Publish hoặc Feedback.'
      : 'Offline guide for App Builder — Pi SoloHost. Add AI in ⚙ Settings for full chat. Ask about Build, Run, Publish, or Feedback.';
  },
};
