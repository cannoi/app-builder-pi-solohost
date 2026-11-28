# v1.6.0 — SoloHost Universal AI Gateway

## Architecture (minimal change)

```
/api/v1/*     → existing kernel (unchanged contract)
/v1/*         → openai-compat.js adapter → same kernel.chat / keys
```

## Files added/changed

| File | Change |
|------|--------|
| `openai-compat.js` | **NEW** — GET /v1/models, POST /v1/chat/completions, GET /v1/health |
| `index.js` | Mount adapter; richer GET /api/v1/gateway; non-blocking Ollama; /v1 404 JSON |
| `docker-compose.yml` | `pi.ui.primary`, loopback host port, named volumes |
| `config_options.yml` | Empty options (keys configured in UI) |
| `test.js` | Gateway token, routing, native chat, compat source checks |
| `package.json` | 1.6.0 |

## Unchanged (preserve)

- Provider engine, vault, memory, activity log, Local AI manager
- POST /api/v1/chat, X-Personal-AI-Key, gateway tokens
- UI framework / dark SoloHost style (label only)

## OpenAI-compatible usage

```
Base URL:  http://personal-ai-hub:8080/v1
API Key:   pah_…  (Authorization: Bearer OR X-Personal-AI-Key)
Model:     auto
```

```bash
curl -s http://personal-ai-hub:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pah_YOUR_TOKEN" \
  -H "X-SoloHost-App-ID: app-builder" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

`model=auto` → Hub smart router (routing mode + health + fallback).
`model=gemini/…` or `local/llama3.2:1b` → forced provider/model.

## SoloHost

- Label `pi.ui.primary: "true"`
- Port `127.0.0.1:${HOST_PORT}:8080`
- No docker.sock, no privileged, no Ollama public port
- Named volumes for data + models
- Ollama starts in background (API never blocked)

## Tests

`node test.js` → ALL TESTS PASSED

## Known limitations

- stream=true not implemented yet
- usage tokens returned as 0 (providers do not always report)
- Live curl against running SoloHost requires deploy on device
- Custom OpenAI-compatible *provider* registration UI still uses fixed catalog (kernel supports openai-compatible type)
