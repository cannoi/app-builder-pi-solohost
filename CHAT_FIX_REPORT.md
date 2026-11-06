# Chat fix v1.1.1 — Model routing (not token)

## Diagnosis from your Activity Log

| Provider | Key status | Real failure |
|---|---|---|
| **Gemini** `AQ.A…` | ACTIVE (32 models) | Tried **pro** models first → 404 / **429 quota**. Free-tier flash models were never reached after 429 locked the whole key. |
| **DeepSeek** `sk-a…` | verified then **BILLING_REQUIRED** | `PROVIDER_402 Insufficient Balance` — account has no credit. Same key cannot chat until balance is topped up. |
| **Local** | ERROR | Ollama not reachable from the container (`fetch failed`). |

So the token was **valid** (list models succeeded). Chat failed because of **model selection + per-model quota handling**, not because the key string was wrong.

## Why pinode-telegram works with the same Gemini key

From [cannoi/pinode-telegram-solohost](https://github.com/cannoi/pinode-telegram-solohost):

1. **Flash-first order** (`GEMINI_FALLBACK_ORDER`): `flash-lite` → `flash` → … → pro last.
2. **Tries up to 4 models**; a 429 on one model does **not** abandon the key.
3. **Sticky preferred model** after first success.
4. Simple `generateContent` body (`contents` + `generationConfig`).

Personal AI Hub previously:

1. Could attempt `gemini-2.5-pro` / `gemini-pro-latest` early.
2. On **429**, threw and set **COOLDOWN on the entire key**, skipping remaining flash models.
3. That matches your log: two pro attempts → 429 → `ALL_PROVIDERS_FAILED`.

## Fixes in v1.1.1

1. **rankChatModels()** — same priority spirit as pinode (flash/lite first, pro demoted).
2. **Per-model 429 rotation** — keep trying other models on the same key (up to 8).
3. **Sticky `selectedModel`** after a successful reply.
4. **Gemini request body** aligned with pinode (system text as conversation turns + `generationConfig`).
5. **Parse** Gemini “use models/X” hints from 404 bodies.
6. Default Gemini catalog models set to flash variants.

## DeepSeek 402

Code cannot invent balance. Top up DeepSeek billing, or use Gemini flash / another provider.

## Local ERROR

Start Ollama on the host and ensure the container can reach it (`OLLAMA_BASE_URL` / `host.docker.internal`).

## Verification

- `node --check` PASS  
- `node test.js` PASS — includes simulated Gemini pro-429 → flash success path.

## Unchanged

Vault encryption, multi-key storage, `/ai` + `/api/v1` gateway mounts, activity log storage, notes actions.
