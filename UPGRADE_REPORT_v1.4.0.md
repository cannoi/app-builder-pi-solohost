# v1.4.0 — Managed Local AI (Ollama service)

## Analysis (before change)
1. Hub only *client* to Ollama via env URL (default host.docker.internal).
2. No Ollama container in stack → users had to install Ollama on host.
3. Continuous probe issues already mitigated in 1.3.1; still no managed service.

## Minimal changes
| File | Change |
|---|---|
| docker-compose.yml | Add `ollama` service + `ollama-data` volume; Hub `OLLAMA_BASE_URL=http://ollama:11434` |
| local.js | Prefer `ollama:11434`; starting state; suggested models; skip re-pull |
| providers.js | Default local base `http://ollama:11434` |
| kernel index.js | routing modes; health localStatus; soft local |
| http.js | GET/POST `/routing` |
| index.js | health includes ollama; gateway note |
| public/index.html | Local AI Ready/Starting UI; suggested downloads; routing select |
| SOLOHOST_INTEGRATION.md | Stack docs |

## Unchanged
Chat API shape, gateway tokens, cloud providers, vault, SPA routes.

## Tests (this environment)
- Unit/integration with mock Ollama: **PASS**
- Full docker compose pull ollama + Builder E2E: **not run here** (no docker compose up / SoloHost runtime). Marked NEEDS USER ACTION on device.

## Acceptance mapping
- Ollama auto in stack: YES (compose)
- No host install / no docker.sock: YES
- Persistent models: volume ollama-data
- API compatible: YES
- Ollama down ≠ Hub failed: YES
