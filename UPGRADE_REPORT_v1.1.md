# Personal AI Hub v1.1.0 — Upgrade Report

## Issues observed
- Local key stuck at `TEST_REQUIRED` with "Models: not discovered"
- Gemini/DeepSeek keys showing `ERROR` even after models were listed
- Chat sometimes felt like "no response" without actionable diagnostics
- TTS/non-chat Gemini models could enter the chat candidate list

## Root causes fixed
1. **Local Ollama JSON parse bug** — `local.models()` returned a raw `Response` instead of parsed JSON, so the Hub never saw model names.
2. **Local key never auto-verified** — cloud keys were verified on add; local stayed `TEST_REQUIRED` until a manual test that also failed to parse models.
3. **Transient ERROR wiped usability** — after a chat network/timeout error, keys became `ERROR` and were excluded from routing even when models were already known.
4. **Non-chat models** — `*-tts` and similar IDs were selectable for chat; they produce empty/invalid chat replies.
5. **Empty provider replies** — treated as hard failure with model rotation + Activity Log entries and request IDs in the UI.

## Implemented against goals

### 1. Fix "No Response" + Activity Log
- Chat failures always surface `message` + `requestId` in the UI.
- Settings → Activity Log already records token verify, chat attempts, provider errors (secrets redacted).
- Logs auto-available via `GET /ai/logs` and `GET /api/v1/logs`.

### 2. Central SoloHost AI Gateway
- Same execution plane on `/ai/*` (Hub UI) and `/api/v1/*` (apps).
- Discovery doc: `GET /api/v1/gateway`.
- Header `X-SoloHost-App-ID` captured in logs.
- Chat UI remains secondary (hidden by default).

### 3. Smart multi-key management
- Multiple tokens per provider (encrypted vault).
- Provider is fixed on each key at creation time.
- Verify on add (cloud + local); periodic refresh for ERROR/TEST_REQUIRED.
- Health statuses: ACTIVE / INVALID / COOLDOWN / BILLING_REQUIRED / ERROR / TEST_REQUIRED.
- Chat prefers ACTIVE keys, can still try ERROR keys that already have models after cooldown.
- Model lists come from live provider discovery and are filtered to chat-capable models only.

### 4. Local AI (Ollama)
- Virtual local key + Ollama base URL candidates (container host aliases included).
- List / pull models; chat through unified path.
- Local status becomes ACTIVE when Ollama responds with models.

### 5. Local learning from cloud usage
- Cloud chat pairs stored in private `training` history (max 500).
- Export: `GET /ai/memory/training` or `/api/v1/memory/training`.
- Clear: `DELETE .../memory/training`.
- This is interaction-pair export for offline/local improvement — not automatic weight training of a cloud model.

## Verification
- `node --check` on server + kernel modules: PASS
- `node test.js`: PASS (provider pipeline, non-chat filter, local models, pending recovery, training export)

## Not fully verifiable here
- Live Gemini/DeepSeek calls with your real tokens
- Ollama runtime inside SoloHost unless Ollama is reachable from the container

## Unchanged on purpose
- Express app shape, JSON store for notes, encrypted vault design, dual mount `/ai` + `/api/v1`
