'use strict';
/**
 * Panel knowledge — keep SHORT for fast AI replies.
 * Long Agent/Upgrade docs belong in Builder coding prompts, not the robot panel.
 */
module.exports = {
  knowledge: `App Builder — Pi SoloHost. Multi-provider AI: Gemini (default), DeepSeek, Custom/OpenAI-compatible, Personal AI Hub. User-selected model wins; otherwise auto when available. Load models lists choices or type a model id. One chat: idea → Build → Run → Improve → Publish.
AI keys once in Settings; robot panel shares the same AI. Feedback tab talks to Feedback Hub (server-side token, never in browser).
Remote QR: learn host port from request Host header; public IP via ipify; link http://IP:hostPort (not container 8080).
Run/Publish/Donate above chat. Language EN/VI on top bar. Always reply in the user's language.`,

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
    const vi = /[ăâêôơưđàáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]/i.test(raw);
    if (/preview|run|chạy|sandbox/.test(m)) {
      return vi
        ? 'Bấm ▶ Run để xem trước. Lỗi thì mô tả trong chat chính để Improve.'
        : 'Tap ▶ Run for a preview. If it fails, describe the issue in the main chat to Improve.';
    }
    if (/feedback|góp ý|nhận xét|hub/.test(m)) {
      return vi
        ? 'Mở tab Feedback trên panel robot để gửi góp ý. Token Hub chỉ nằm trên server, không hiện trong trình duyệt.'
        : 'Open the Feedback tab on the robot panel to send feedback. The Hub token stays on the server only.';
    }
    if (/ai|key|provider|cấu hình|settings|panel/.test(m)) {
      return vi
        ? 'AI một lần ở ⚙ Settings (Gemini/DeepSeek/Custom). Panel robot dùng chung — không nhập key lần hai.'
        : 'Configure AI once in ⚙ Settings (Gemini/DeepSeek/Custom). The robot panel shares it — no second key.';
    }
    if (/solohost|compose|config_options|cài đặt|qr|remote/.test(m)) {
      return vi
        ? 'QR remote: IP public + cổng SoloHost (HOST_PORT), không dùng 8080 trong container. Sau Publish copy compose + config_options vào SoloHost.'
        : 'Remote QR uses public IP + SoloHost HOST_PORT (not container 8080). After Publish, copy compose + config_options into SoloHost.';
    }
    return vi
      ? 'App Builder: hỏi về tạo app, chạy thử, xuất bản, GitHub token hoặc cài đặt SoloHost. Hãy cấu hình AI trong Settings để tôi trả lời đầy đủ.'
      : 'App Builder: ask about creating an app, running a preview, publishing, GitHub token, or SoloHost install. Configure AI in Settings for full answers.';
  },
};
