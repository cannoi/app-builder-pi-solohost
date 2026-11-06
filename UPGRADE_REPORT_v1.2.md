# Personal AI Hub v1.2.0

## Done

### 1. Free-tier model priority (all providers)
- Generalized Gemini flash-first ranking to OpenAI (mini), Anthropic (haiku), DeepSeek (chat/flash), Groq (instant/small), OpenRouter (`:free`).
- Pro / opus / large models demoted; sticky last-good model still preferred after success.

### 2. Local AI download fixed
- Multi-URL Ollama discovery: `OLLAMA_BASE_URL`, `host.docker.internal`, `host.containers.internal`, `172.17.0.1`, localhost.
- Local key verify uses the same multi-URL path (not a single hard-coded base).
- Pull timeout raised to 10 minutes; pre-check health before pull.
- UI: preset models, Refresh, status text, clearer errors.

### 3. Home / main screen navigation
- Header **Hub** button returns to main dashboard.
- Chat panel has **Về màn hình chính**.
- Chat remains secondary; Hub dashboard is primary.

### 4. Full feature linkage on UI
- Dashboard: keys health, providers, local models, activity, gateway.
- Settings: keys test, activity log, memory.
- Sidebar: add provider keys, notes.
- Chat: provider/model selectors + back to Hub.

### 5. Gateway keys & links for other SoloHost apps
- Base URL + curl sample (copy buttons).
- Endpoints shown: `/api/v1/chat`, `/api/v1/health`, `/api/v1/gateway`, `/ai-hub-sdk.js`.
- **Create gateway token** (`pah_…`) — shown once; header `X-Personal-AI-Key`.
- List / revoke tokens.
- SDK updated to `/api/v1/chat` + optional token.

## Not done / external dependency
- Ollama must be installed and reachable from the container for local download to succeed.
- DeepSeek still needs account balance (402 is provider-side).
- Strict mandatory gateway auth for all callers is soft: validation only when a token header is sent (Hub UI stays open). Hard lock-down can be enabled later if required.

## Unchanged
- Encrypted cloud API key vault, multi-key per provider, `/ai` + `/api/v1` dual mount, notes actions, activity log storage.

## Tests
- `node --check` PASS
- `node test.js` PASS (ranking, local pull mock, gateway tokens, chat)
