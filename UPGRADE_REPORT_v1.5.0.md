# v1.5.0 — Same-container managed Ollama

## Problem
Sidecar image `ollama/ollama` stayed **0 bytes** on SoloHost → container never served `:11434`.

## Solution (minimal, no docker.sock)
1. Download official Ollama **linux binary** at **Hub image build** time (amd64/arm64 from GitHub releases).
2. `docker-entrypoint.sh` runs `ollama serve` then `node index.js` in one container.
3. Default `OLLAMA_BASE_URL=http://127.0.0.1:11434`.
4. Models volume `personal-ai-ollama-data` → `/app/ollama-data`.
5. Compose simplified to **one service** (SoloHost-friendly).

## Not required anymore
- Host Ollama install
- Working sidecar `ollama/ollama` image
- docker.sock / privileged

## Trade-off
Hub image is larger (includes Ollama binary). First build needs network to GitHub releases.

## Tests
Unit tests still PASS with mock fetch. Full image build requires Docker build network on device.
