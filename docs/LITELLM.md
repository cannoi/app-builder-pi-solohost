# LiteLLM layer (always on)

App Builder runs a **LiteLLM-style normalization layer** on every AI call. You do **not** pick “LiteLLM” in Settings.

## Default (no extra container)

1. Add Gemini / DeepSeek / Custom keys in Settings as usual.
2. Builder calls the provider, then **normalizes** the response to one schema:
   - `text`, `model`, `provider`, `finishReason`, `tokens`, `durationMs`
3. Routing, ladder, circuit breaker, and Response Doctor stay the same.

## Optional external LiteLLM Proxy

Set environment variables (Docker / SoloHost config):

```bash
LITELLM_BASE_URL=http://litellm:4000/v1
LITELLM_API_KEY=sk-your-master-or-virtual-key
```

When `LITELLM_BASE_URL` is set, **completions go through the proxy first**. If the proxy fails, Builder falls back to direct providers.

Example Compose: `docker-compose.litellm.example.yml`.

## Settings

- Configure **Gemini**, **DeepSeek**, **Custom**, etc.
- There is **no** LiteLLM provider option in the UI (layer is automatic).
