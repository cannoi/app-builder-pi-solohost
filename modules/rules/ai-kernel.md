RULE_NAME: Integrate_AI_App_Kernel
AUTO_APPLY: true

GOAL: Integrate the supplied portable AI kernel into this existing app with the smallest safe patch. Preserve the app architecture, existing database, primary workflow, and SoloHost package contract.

REQUIRED CAPABILITIES:
- Authorized AI chat and action routes
- Existing database adapter with explicit collection and field allowlists
- At least one action backed by an existing app service
- App primary workflow works when AI is unavailable

STEPS:
1. Reuse vendor/ai-app-kernel/src/index.js. Do not duplicate or rewrite the module.
2. Detect the existing server framework and add only missing routes: GET /ai/health, GET /ai/schema, GET /ai/capabilities, POST /ai/chat, and POST /ai/act.
3. Use the existing database through createCustomStore when available. Do not create a second database.
4. Register only existing, safe app actions. Handlers must call existing functions.
5. Define explicit collection and field allowlists. Do not expose credential, token, wallet, payment, or secrets collections or fields.
6. Mount module routes behind the app's existing authorization middleware. If there is no safe authorization callback, stop with NEEDS_USER_ACTION; never expose chat or actions publicly.
7. Provider tokens must stay in headers or server environment, never URLs, logs, AI responses, or GET results. Provider credentials must not cross to another provider.
8. Add an AI button only if the app has no chat UI. Use concise English labels; answer in the user's language.
9. If AI is unavailable, the existing app must continue to work.

DEFINITION_OF_DONE:
The app still works without an AI token; authorized AI routes use the real schema, existing database, and at least one existing action.
