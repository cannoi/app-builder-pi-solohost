# v1.4.1 — Ollama image / connectivity fix

## Root cause of your log
`fetch failed` to `http://ollama:11434` while image is **0 bytes** means the Ollama container has no valid binary. This is a **Docker image pull problem on the host**, not a missing host `apt install ollama`.

## Changes
1. Pin `ollama/ollama:0.6.8` (avoid broken `:latest` partial pulls)
2. `pull_policy: missing`, healthcheck `ollama list`, network aliases
3. `OLLAMA_HOST=0.0.0.0:11434` inside Ollama container
4. Longer negative cache (1 min starting / 5–15 min offline)
5. Rate-limit `local.models.failed` logs (max 1 / 5 min) so `/health` does not spam
6. Clearer UI hint + `OLLAMA_TROUBLESHOOTING.md`

## Still required on device
Re-pull a full Ollama image and `docker compose up -d` (see troubleshooting doc).

## Tests
`node test.js` PASS (mocked). Live image pull is host-side.
