# Managed Local AI troubleshooting

## Expected logs after deploy
```
[hub] Starting managed Ollama: /usr/local/bin/ollama serve ...
[hub] Ollama is ready
[hub] Ollama boot status: {"ok":true,...}
```

## If still "Cannot reach Ollama"
1. Rebuild: `docker compose build --no-cache && docker compose up -d`
2. Confirm binary: `docker exec personal-ai-hub ollama --version`
3. Confirm API: `docker exec personal-ai-hub wget -qO- http://127.0.0.1:11434/api/tags`
4. Architecture must be **amd64** or **arm64** (Ollama does not support 32-bit armv7)
5. Wait 1–2 minutes after boot on slow Pi hardware

Cloud providers are independent of Ollama.
