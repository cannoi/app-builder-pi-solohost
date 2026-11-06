# v1.6.1 — Surgical fix: mount OpenAI-compatible /v1

## Root cause
`openai-compat.js` existed and was **imported** in `index.js`, but `mountOpenAICompat(app, …)` was **never called**.
Catch-all `app.use(['/api','/ai','/v1'], …)` therefore returned **404 NOT_FOUND** for `GET /v1/models`.

App Builder could reach `/health` (200) but model discovery failed → "No usable model is known for this provider."

## Fix
1. Call `mountOpenAICompat(app, { kernel: ai, serviceName })` **after** `ai.mount` and **before** the `/v1` catch-all.
2. `/v1/models` merges live Ollama models + usable cloud key models + always `auto`.
3. Stricter gateway auth on `/v1` when tokens exist (missing key → 401 for server clients).
4. Real HTTP integration tests (mini router + fetch) — not string-only checks.

## Tests (PASS)
- GET /v1/health → 200
- GET /v1/models → 200, contains `auto` + local model
- POST /v1/chat/completions model=auto → 200
- stream=true → 400 STREAM_NOT_SUPPORTED
- unknown /v1 → JSON 404
- missing/invalid token → 401
- valid Bearer → 200
- explicit local/qwen… → 200
- mount order before catch-all asserted

## App Builder config
```
Provider: Custom / OpenAI-compatible
Base URL: http://personal-ai-hub:8080/v1
API Key:  pah_…
Model:    auto
```
