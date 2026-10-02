# PROMPT — add reliable "AI token check / model list" to another app

Copy the block below into a coding AI together with the app source. Works for any Node app that already has (or will get) an AI provider/token settings screen.

```
Add a reliable AI token check to this app using the portable module "ai-app-kernel" v1.1.3+ (src/router.js + src/providers.js).
Minimal patch. Do not rewrite the app, its routes, auth, or storage format.

1. Copy ai-app-kernel/ into the project (or update src/router.js and src/providers.js if already present).
2. Server: add ONE admin-only route POST /api/settings/test-ai { provider, token, local_base_url?, model? }:
   - token = body.token || the saved key; provider = body.provider || saved provider || detectProviderFromToken(token)
   - If detectProviderFromToken(token) is a strong hint (gsk_, sk-or-, xai-, AIza) and differs from the chosen provider, DO NOT call any API: answer { ok:false, suggested_provider, warning }
   - Otherwise call verifyProvider({ provider, apiKey: token, baseUrl, model }) and return its result as JSON (HTTP 200 even when ok:false).
3. UI: a "Check token" button next to the token field. Show:
   ok:true  -> "Token OK. Models: <first 6>" and fill the model <select> with result.models
   ok:false -> result.warning verbatim (it states the real reason). If suggested_provider is set, switch the provider <select>.
   Optional: on token paste, POST /api/settings/peek-token { token } and auto-select the provider only for strong hints (never for a bare "sk-").
4. Never: log the token, put it in a URL, return it from any GET, or send it to a provider other than the one selected.
5. Do not parse model lists yourself. OpenAI-style APIs return { data:[...] } (NOT { models:[...] }); Gemini returns names like "models/gemini-2.5-flash". parseModelList() already handles this.
6. Verify (must all pass): node tests/ai-discovery.test.js; valid DeepSeek key -> ok + models; wrong key -> ok:false + "401"; Gemini key while DeepSeek selected -> suggested_provider "gemini"; provider unreachable -> kind "network"/"timeout" (not "token invalid").
7. Report what you changed, what you could not verify (a real provider key is needed for a live test), and anything you had to alter outside this scope.
```
