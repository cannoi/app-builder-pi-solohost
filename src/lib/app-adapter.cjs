Remote link like Snake Arcade: learn host port from request Host header; public IP via ipify; URL http://IP:hostPort. 'use strict';
/**
 * Panel knowledge — keep SHORT for fast AI replies.
 * Long Agent/Upgrade docs belong in Builder coding prompts, not the robot panel.
 */
module.exports = {
  knowledge: `Quick actions: Run/Publish/Donate use data-action→quick(). Welcome shows on New app. More menu labels single icon. Playwright optional for Run. App Builder — Pi SoloHost. Idea → Build → Run → Improve → Publish for Pi SoloHost apps.
You are App Builder only. Never ask for wallet seeds. Never reveal API/GitHub/feedback tokens. Feedback Hub is built-in.
Install fields: full|defaults|auth|custom. Validation OK|FAIL|UNREACHABLE. One chat routes CREATE/MODIFY/RUN/PUBLISH/EXPORT/UPGRADE. Medium-risk applies with checkpoint; high risk needs confirm. Remote QR auto-detects public IP and SoloHost HOST_PORT (http://IP:PORT); PUBLIC_URL overrides. Remote QR in AI panel. Remote QR in AI panel. Main UI: Run/Publish/Donate above the chat box. Language toggle EN/VI is on the top bar after Settings. Image start uses docker-entrypoint preflight (yaml/sqlite). GitHub publish smoke accepts any HTTP response on /health|/ready|/; image tag resolved by SHA. Remote QR uses the same BUILDER_ACCESS_PASSWORD as app login; public URL is PUBLIC_IP:SoloHost host port. Always reply in the user's language.`,

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
    if (!allowed