# SoloHost AI Gateway

## App Builder / Custom Provider

| Field | Value |
|-------|--------|
| Type | OpenAI-compatible / Custom |
| Base URL | `http://personal-ai-hub:8080/v1` |
| API Key | `pah_…` (Hub → Gateway tokens) |
| Model | `auto` |

```bash
curl -s http://personal-ai-hub:8080/v1/models   -H "Authorization: Bearer pah_YOUR_TOKEN"

curl -s http://personal-ai-hub:8080/v1/chat/completions   -H "Content-Type: application/json"   -H "Authorization: Bearer pah_YOUR_TOKEN"   -H "X-SoloHost-App-ID: app-builder"   -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

Native API still available: `POST /api/v1/chat`
