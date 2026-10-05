# v1.5.1 — Local chat timeout on CPU/Pi

## Symptom
Ollama Ready, model `llama3.2:3b` listed, but chat fails:
`REQUEST_TIMEOUT_120000MS` (2 minutes).

## Cause
On SoloHost CPU (often Pi-class), a 3B model can need **several minutes** for the first reply. Hard 120s abort was too short.

## Fixes
1. Local chat timeout **10 minutes** (`OLLAMA_CHAT_TIMEOUT_MS`, default 600000)
2. Cap generation: `num_predict=256`, `num_ctx=2048` (faster on CPU)
3. Sync Ollama base URL before each local chat
4. Timeout → short cooldown (5s), not long key lockout
5. Rate-limit `local.models.ok` logs (was every ~60s from health)
6. `OLLAMA_NUM_PARALLEL=1` in entrypoint

## Tip
Prefer lighter models on weak CPU: `llama3.2:1b`, `qwen3:4b` after download.
Routing **Balanced** will fall back to cloud if local is still too slow.
