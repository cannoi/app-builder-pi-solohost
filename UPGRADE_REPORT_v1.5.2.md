# v1.5.2 — Ollama auto-start on SoloHost Pi Network

## Problem
Fresh SoloHost deploy: Local AI download fails — cannot reach 127.0.0.1:11434 or ollama:11434.
Often ENTRYPOINT is overridden and only `node index.js` runs → Ollama never started.

## Fix
1. `start-ollama.js` — on Hub boot, if Ollama API is down, spawn `ollama serve` from Node
2. Works with or without docker-entrypoint.sh
3. Clearer error text (same-container, not sidecar 0-byte)
4. Dockerfile soft-fail on unsupported CPU arch (e.g. armv7)

## Deploy
Rebuild image and restart. Check logs for:
`[hub] Starting managed Ollama` / `[hub] Ollama is ready`

Cloud keys continue to work while Local AI starts.
