'use strict';
/**
 * App Builder — Pi SoloHost adapter for Universal AI module.
 * Knowledge + offline localReply; actions whitelist only (no destructive ops).
 */
module.exports = {
  knowledge: `
App Builder — Pi SoloHost helps non-technical users create apps for Pi Network SoloHost.

MAIN FLOW
1. Describe the app idea in chat (any language).
2. Builder plans, generates source, runs tests, opens a safe preview.
3. Improve with feedback; Publish needs GitHub owner + token in Settings.
4. SoloHost install uses the GHCR image after GitHub Actions succeeds.

UI CONTROLS
- Chat: talk to Builder about your project (build / improve / publish).
- ⚙ Settings (top): GitHub token, Builder AI providers for coding jobs, activity log.
- Robot FAB (bottom-right): Universal AI assistant + Feedback Hub + module Settings/Logs.
- ▶ Run: local preview. 🚀 Publish: needs GitHub credentials.
- BUILDER_ACCESS_PASSWORD (SoloHost env): optional remote access gate.

LIMITS
- No docker.sock. Preview is sandboxed.
- Publish is blocked without GitHub owner+token.
- Coding AI (Gemini/DeepSeek/Custom hub) is configured in Builder Settings, separate from this panel's AI key.
- Never ask users for private keys, seed phrases, or wallet secrets.
`,

  actions: [
    { name: 'open_builder_settings', description: 'Remind user to open the top Settings gear for GitHub and coding AI providers.' },
    { name: 'explain_publish', description: 'Explain Publish prerequisites: successful Run + GitHub owner/token.' },
    { name: 'explain_preview', description: 'Explain how Run/preview works on SoloHost.' },
  ],

  async getContext(ctx) {
    return {
      app: 'App Builder — Pi SoloHost',
      surface: 'universal-ai-panel',
      hint: 'User is asking from the robot assistant panel, not the main build chat.',
      ...(ctx || {}),
    };
  },

  async executeAction({ name }) {
    const allowed = ['open_builder_settings', 'explain_publish', 'explain_preview'];
    if (!allowed.includes(name)) return { ok: false, error: 'Action not allowed' };
    return { ok: true, action: name };
  },

  async localReply(message) {
    const m = String(message || '').toLowerCase();
    if (/publish|xuất bản|xuat ban|github/.test(m)) {
      return 'To Publish: (1) Run the app successfully, (2) open ⚙ Settings and save GitHub owner + token, (3) tap 🚀 Publish. Without a GitHub token Publish is blocked.';
    }
    if (/preview|run|chạy|chay/.test(m)) {
      return 'Tap ▶ Run to start a safe local preview. Fix any errors with Improve, then Publish when ready.';
    }
    if (/password|mật khẩu|mat khau|access/.test(m)) {
      return 'Remote access uses BUILDER_ACCESS_PASSWORD from SoloHost config_options. If set, open /login.html and enter that password.';
    }
    if (/feedback|góp ý|gop y/.test(m)) {
      return 'Open the Feedback tab in this panel to send a message or read Hub notices. Donate info appears only from the Feedback Hub sync.';
    }
    if (/ai|model|provider|key|token/.test(m)) {
      return 'This panel has its own AI Settings (provider + API key). The top ⚙ Settings configures the coding AI used to generate/repair apps. Both can use Custom / Personal AI Hub.';
    }
    return 'I am the offline guide for App Builder — Pi SoloHost. Add an API key in this panel\'s Settings for full AI chat. Ask about build, preview, Publish, GitHub token, or feedback.';
  },
};
