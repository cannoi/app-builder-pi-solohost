# v1.3.0 — Shared AI server for SoloHost network

## Problem
Calling `http://127.0.0.1:8080/api/v1/chat` **from App Builder’s container** hits App Builder itself, not Personal AI Hub — response was HTML, not AI JSON.

## Architecture (intended)
```
App Builder / other SoloHost apps
    →  http://personal-ai-hub:8080/api/v1/chat
    →  X-Personal-AI-Key: pah_…
Personal AI Hub
    →  route to Ollama / Gemini / DeepSeek / …
```

## Done
1. **Listen `0.0.0.0`** (already) + document service DNS `personal-ai-hub`.
2. **CORS** for cross-app browser/server calls.
3. **API never returns SPA HTML** — unknown `/api/*` and `/ai/*` → JSON 404.
4. **GET /api/v1/gateway** discovery: `serviceName`, `baseUrls`, absolute chat URL, curl + node examples, explicit warning against `127.0.0.1` from other containers.
5. **docker-compose.yml** — service name `personal-ai-hub`, network `solohost`, host port `18080:8080`, healthcheck.
6. **Dockerfile** — HEALTHCHECK, non-root user, `SERVICE_NAME`.
7. **UI Gateway panel** shows Docker DNS URL for App Builder + host UI URL.
8. **SOLOHOST_INTEGRATION.md** integration guide.

## Correct test from App Builder
```bash
wget -qO- http://personal-ai-hub:8080/api/v1/gateway
node -e "fetch('http://personal-ai-hub:8080/api/v1/chat',{method:'POST',headers:{'Content-Type':'application/json','X-SoloHost-App-ID':'app-builder','X-Personal-AI-Key':'pah_YOUR_TOKEN'},body:JSON.stringify({message:'xin chao'})}).then(r=>r.text()).then(console.log)"
```

## Not done / ops
- Joining App Builder to the same Docker network must be done in SoloHost deploy (compose `networks:` / `external: true`).
- If SoloHost uses a different network name, set it in compose.
- Live multi-container smoke test depends on the user’s SoloHost runtime.

## Unchanged
Kernel routing, vault, provider keys, chat UI, gateway token create/revoke APIs.
