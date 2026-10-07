'use strict';
/**
 * App Adapter for Universal AI panel (robot FAB).
 * Coding AI remains in src/ai (AIGateway). Panel chat reuses it via cloudFallback
 * when the panel has no own API key — one unified AI system for the user.
 */
module.exports = {
  knowledge: `
App Builder — Pi SoloHost v1.4.75 (Pi Network).
Lean AI Builder: idea → working SoloHost app.

Reply in the user's language (Vietnamese or English). Keep answers short and practical.

══════════════════════════════════════
PRODUCT IDENTITY
══════════════════════════════════════
- This product is "App Builder — Pi SoloHost".
- It is NOT "Personal AI Hub". Personal AI Hub may appear only as an optional Custom / OpenAI-compatible provider base URL in Settings.
- Never claim this app is Personal AI Hub.

══════════════════════════════════════
MAIN FLOW
══════════════════════════════════════
1. Main chat: describe the app idea → AI generates/repairs code (coding AI from top ⚙ Settings).
2. ▶ Run: safe local preview (no host Docker socket).
3. Improve: describe bugs/changes in main chat; DARE + AI apply smallest safe fixes.
4. 🚀 Publish: requires successful Run + GitHub owner + classic PAT (repo, workflow, write:packages) in top ⚙ Settings.
5. SoloHost install package is produced after publish (image-based, not build:).

══════════════════════════════════════
UI MAP
══════════════════════════════════════
- Main chat = Build / Improve (coding AI: Gemini, DeepSeek, Custom, Ollama, Provider Hub).
- Robot FAB (bottom-right) = this assistant: Chat | Feedback | Settings | Logs.
- Robot panel AI: if you set a key in panel Settings it uses that; otherwise it automatically uses the same coding AI from top ⚙ Settings (unified system). Offline localReply still works with no key.
- Top ⚙ Settings = GitHub token + coding AI providers + Advisor.
- Feedback Hub notices → badge on FAB (only when unread > 0). Donate info comes only from Hub sync.

══════════════════════════════════════
PUBLISH RULES
══════════════════════════════════════
- Publish is blocked without a valid GitHub token (by design).
- Token page: https://github.com/settings/tokens/new (classic) → scopes: repo, workflow, write:packages.
- After first repo create: Repository Settings → Actions → General → Workflow permissions → Read and write → Save.
- Existing GHCR package: Package settings → Manage Actions access → grant Write to the workflow repo.
- Source projects may use GitHub Actions "build:"; SoloHost install packages require "image:" and reject "build:".

══════════════════════════════════════
PREVIEW / RUN
══════════════════════════════════════
- Preview runs inside Builder runtime (native). No host Docker daemon.
- Idle previews are cleaned after ~15 minutes.
- On failure: describe the error in main chat for Improve / DARE auto-repair.

══════════════════════════════════════
AI / PROVIDERS
══════════════════════════════════════
- Coding AI (top Settings): Gemini, DeepSeek, Custom OpenAI-compatible, Local (Ollama), Provider Hub multi-key.
- Panel AI Settings: full catalog (openai, gemini, deepseek, anthropic, openrouter, groq, mistral, xai, custom, local).
- One system for the user: panel without its own key falls back to Builder coding AI.
- Never put API keys or secrets in generated app source.

══════════════════════════════════════
FEEDBACK
══════════════════════════════════════
- Use the Feedback tab on the robot panel only (old modal is retired).
- Notices and donate accounts load from SoloHost Feedback Hub after sync.
- Badge shows only when there are unread notices.

══════════════════════════════════════
SAFETY
══════════════════════════════════════
- Never ask for wallet seeds, private keys, or passwords.
- Never expose secrets in chat or logs.
- Do not mount or request a host Docker socket.
- Do not tell users to run raw git commands for normal Publish.

══════════════════════════════════════
TROUBLESHOOTING SHORTCUTS
══════════════════════════════════════
- DeepSeek 402 → switch to Gemini or add credit.
- GHCR unauthorized → package visibility / workflow Write access / wrong image name.
- Blank SoloHost screen → Express not serving public/ on / (DARE can fix).
- Cannot GET / → same root static-serve issue.
- "No usable model" on Custom provider → check base URL ends with /v1 and key is valid.
`,

  actions: [
    { name: 'open_builder_settings', description: 'Open top Settings for GitHub and coding AI.' },
    { name: 'explain_publish', description: 'Explain Publish requirements (Run + GitHub token).' },
    { name: 'explain_preview', description: 'Explain Run / safe preview.' },
    { name: 'explain_feedback', description: 'Explain Feedback tab and Hub notices.' },
    { name: 'explain_ai', description: 'Explain unified AI: coding Settings + panel fallback.' },
  ],

  async getContext(ctx) {
    return {
      app: 'App Builder — Pi SoloHost',
      version: '1.4.75',
      surface: 'robot-panel',
      ...(ctx || {}),
    };
  },

  async executeAction({ name }) {
    const allowed = [
      'open_builder_settings',
      'explain_publish',
      'explain_preview',
      'explain_feedback',
      'explain_ai',
    ];
    if (!allowed.includes(name)) return { ok: false, error: 'Action not allowed' };
    return { ok: true, action: name };
  },

  async localReply(message) {
    const raw = String(message || '');
    const m = raw.toLowerCase();
    const vi = /[àáạảãâăèéêìíòóôơùúưýăđ]|bạn|tôi|không|xin chào|chào|làm gì|ứng dụng|hướng dẫn/.test(raw);

    if (/^(xin\s*)?chào|hello|hi\b|hey\b|alo/.test(m.trim())) {
      return vi
        ? 'Xin chào! Tôi là trợ lý App Builder — Pi SoloHost. Mô tả ý tưởng ở chat chính để Build, bấm ▶ Run xem preview, thêm GitHub token ở ⚙ rồi Publish. Panel robot dùng chung AI coding nếu bạn chưa dán key riêng.'
        : 'Hello! I am the App Builder — Pi SoloHost assistant. Describe your idea in the main chat to Build, tap ▶ Run for preview, add a GitHub token in ⚙ Settings, then Publish. This panel reuses coding AI when you have not set a separate key.';
    }
    if (/làm gì|what.*(app|this)|app này|what is this/.test(m)) {
      return vi
        ? 'App Builder tạo app SoloHost cho Pi Network: ý tưởng → AI sinh code → Run thử → Improve → Publish GitHub/GHCR → cài trên SoloHost.'
        : 'App Builder creates SoloHost apps for Pi Network: idea → AI generates code → Run → Improve → Publish to GitHub/GHCR → install on SoloHost.';
    }
    if (/publish|xuất bản|github|ghcr/.test(m)) {
      return vi
        ? 'Publish cần: (1) ▶ Run thành công, (2) ⚙ Settings → GitHub owner + token classic (repo, workflow, write:packages) → Save, (3) 🚀 Publish. Thiếu token sẽ bị chặn cố ý.'
        : 'Publish needs: (1) successful Run, (2) ⚙ Settings → GitHub owner + classic PAT (repo, workflow, write:packages) → Save, (3) 🚀 Publish. Missing token blocks Publish on purpose.';
    }
    if (/preview|run|chạy|sandbox/.test(m)) {
      return vi
        ? 'Bấm ▶ Run để mở preview an toàn (không cần Docker host). Lỗi thì mô tả trong chat chính để Improve/DARE sửa.'
        : 'Tap ▶ Run for a safe preview (no host Docker). On failure, describe the issue in the main chat for Improve/DARE repair.';
    }
    if (/feedback|góp ý|thông báo|notice/.test(m)) {
      return vi
        ? 'Tab Feedback trên panel robot: gửi góp ý và đọc thông báo Hub. Badge chỉ hiện khi còn thông báo chưa đọc. Donate lấy từ Hub, không hard-code.'
        : 'Feedback tab on the robot panel: send feedback and read Hub notices. Badge shows only when unread notices exist. Donate comes from Hub sync only.';
    }
    if (/ai|model|key|token|provider|ollama|gemini|deepseek/.test(m)) {
      return vi
        ? 'AI coding cấu hình ở ⚙ Settings trên cùng (Gemini, DeepSeek, Custom, Ollama…). Panel robot dùng chung AI đó nếu chưa dán key riêng trong panel Settings — một hệ thống AI thống nhất.'
        : 'Coding AI is configured in top ⚙ Settings (Gemini, DeepSeek, Custom, Ollama…). The robot panel reuses that AI when you have not set a separate panel key — one unified AI system.';
    }
    if (/solohost|cài đặt|install/.test(m)) {
      return vi
        ? 'Sau Publish, package SoloHost dùng image: (không dùng build:). Cài trên thiết bị SoloHost theo hướng dẫn repo.'
        : 'After Publish, the SoloHost package uses image: (not build:). Install on the SoloHost device per the repo instructions.';
    }
    return vi
      ? 'Hướng dẫn offline App Builder — Pi SoloHost v1.4.75. Thêm AI ở ⚙ Settings để chat đầy đủ. Hỏi về Build, Run, Publish, Feedback hoặc AI thống nhất.'
      : 'Offline guide for App Builder — Pi SoloHost v1.4.75. Add AI in ⚙ Settings for full chat. Ask about Build, Run, Publish, Feedback, or the unified AI system.';
  },
};
