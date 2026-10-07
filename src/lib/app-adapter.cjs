'use strict';
/**
 * App Builder — Pi SoloHost adapter for Universal AI panel.
 * Keep knowledge in sync with product behavior (Publish gate, access password, FAB panel).
 */
module.exports = {
  knowledge: `
App Builder — Pi SoloHost helps everyday users create apps for Pi Network SoloHost.

LANGUAGE
- Reply in the user's language (Vietnamese or English). Keep answers short and practical.

MAIN FLOW
1. Describe the app idea in the main Builder chat (any language).
2. Builder plans, generates source, runs tests, opens a safe preview (▶ Run).
3. Improve with feedback in the main chat; use Improve when something breaks.
4. Publish (🚀) needs: successful Run + GitHub owner + GitHub token in top ⚙ Settings.
5. After Publish, GitHub Actions builds the GHCR image for SoloHost install.

UI MAP
- Main chat: build / improve / publish the project (coding AI from top Settings).
- Top ⚙ Settings: GitHub owner/token, coding AI providers (Gemini, DeepSeek, Custom hub), activity log, AI Advisor.
- Robot FAB (bottom-right): this assistant panel — Chat | Feedback | Settings | Logs.
  · Panel Chat: guide questions (offline local guide if no API key).
  · Panel Feedback: send feedback + Hub notices (badge). Donate appears only from Hub sync.
  · Panel Settings: optional separate API key for this assistant (Custom/Local/Gemini/…).
- BUILDER_ACCESS_PASSWORD (SoloHost env): if set, users must unlock via /login.html before using Builder.

PUBLISH RULES
- Without GitHub username + token in Settings, Publish is blocked with a clear error.
- Run must pass (preview healthy) before Publish.
- Security scan must not have critical issues.

LIMITS & SAFETY
- No docker.sock. Preview is sandboxed.
- Never ask for wallet seed phrases, private keys, or Pi mnemonic.
- Ingest / Hub tokens never appear in the browser; Feedback goes through server routes only.
`,

  actions: [
    { name: 'open_builder_settings', description: 'Open top Settings for GitHub token and coding AI providers.' },
    { name: 'explain_publish', description: 'Explain Publish prerequisites: Run OK + GitHub owner/token.' },
    { name: 'explain_preview', description: 'Explain ▶ Run and preview on SoloHost.' },
    { name: 'explain_feedback', description: 'Explain Feedback tab and Hub notices badge.' },
  ],

  async getContext(ctx) {
    return {
      app: 'App Builder — Pi SoloHost',
      surface: 'universal-ai-panel',
      features: [
        'publish_requires_github_token',
        'optional_access_password',
        'universal_feedback_panel',
        'coding_ai_hub_in_top_settings',
      ],
      ...(ctx || {}),
    };
  },

  async executeAction({ name }) {
    const allowed = ['open_builder_settings', 'explain_publish', 'explain_preview', 'explain_feedback'];
    if (!allowed.includes(name)) return { ok: false, error: 'Action not allowed' };
    return { ok: true, action: name };
  },

  async localReply(message) {
    const m = String(message || '').toLowerCase();
    const vi = /[àáạảãâăđèéêìíòóôơùúưý]|bạn|tôi|không|cách|làm|gì|xin chào|chào/.test(String(message || ''));
    if (/^(xin\s*)?chào|hello|hi\b|hey\b/.test(m.trim())) {
      return vi
        ? 'Xin chào! Tôi là trợ lý App Builder — Pi SoloHost. Bạn có thể mô tả ý tưởng app trong chat chính để Build, bấm ▶ Run xem preview, và Publish khi đã có GitHub token trong ⚙ Settings. Hỏi tôi về Publish, preview, Feedback hoặc Settings.'
        : 'Hello! I am the App Builder — Pi SoloHost assistant. Describe your app idea in the main chat to Build, tap ▶ Run for preview, and Publish after saving a GitHub token in ⚙ Settings. Ask me about Publish, preview, Feedback, or Settings.';
    }

    if (/publish|xuất bản|xuat ban|github/.test(m)) {
      return vi
        ? 'Để Publish: (1) ▶ Run thành công, (2) ⚙ Settings → nhập GitHub owner + token → Save, (3) bấm 🚀 Publish. Thiếu token thì Publish bị chặn.'
        : 'To Publish: (1) Run successfully, (2) ⚙ Settings → GitHub owner + token → Save, (3) tap 🚀 Publish. Without a token, Publish is blocked.';
    }
    if (/preview|run|chạy|chay/.test(m)) {
      return vi
        ? 'Bấm ▶ Run để mở preview an toàn. Nếu lỗi, mô tả trong chat chính để Improve, rồi Publish khi sẵn sàng.'
        : 'Tap ▶ Run for a safe local preview. If something fails, describe it in the main chat to Improve, then Publish when ready.';
    }
    if (/password|mật khẩu|mat khau|access|đăng nhập|dang nhap/.test(m)) {
      return vi
        ? 'Nếu SoloHost đặt BUILDER_ACCESS_PASSWORD, mở /login.html và nhập mật khẩu đó trước khi dùng Builder.'
        : 'If SoloHost sets BUILDER_ACCESS_PASSWORD, open /login.html and enter that password before using Builder.';
    }
    if (/feedback|góp ý|gop y|badge/.test(m)) {
      return vi
        ? 'Mở tab Feedback trên panel robot để gửi góp ý hoặc đọc thông báo Hub. Badge chỉ hiện khi còn thông báo chưa đọc. Thông tin ủng hộ chỉ lấy từ Hub, không hard-code.'
        : 'Open the Feedback tab on the robot panel to send feedback or read Hub notices. The badge shows only when there are unread notices. Donate info comes from Hub sync only.';
    }
    if (/ai|model|provider|key|token|gemini|deepseek/.test(m)) {
      return vi
        ? 'Panel này có Settings AI riêng (provider + API key). ⚙ Settings trên cùng cấu hình AI coding (tạo/sửa app). Cả hai đều hỗ trợ Custom / Personal AI Hub.'
        : 'This panel has its own AI Settings (provider + API key). Top ⚙ Settings configures the coding AI that builds/repairs apps. Both support Custom / Personal AI Hub.';
    }
    return vi
      ? 'Tôi là hướng dẫn offline của App Builder — Pi SoloHost. Thêm API key trong Settings của panel để chat AI đầy đủ. Hỏi về build, preview, Publish, GitHub token hoặc Feedback.'
      : 'I am the offline guide for App Builder — Pi SoloHost. Add an API key in this panel\'s Settings for full AI chat. Ask about build, preview, Publish, GitHub token, or Feedback.';
  },
};
