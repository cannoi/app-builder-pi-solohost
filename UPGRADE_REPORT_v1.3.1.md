# v1.3.1

## Done
1. **UI header** — equal-height buttons, logo not squished, responsive (icon-only on narrow screens).
2. **Stop continuous Ollama scan** — positive/negative cache (60s / 2–15 min); background health skips local; UI no longer polls dashboard every 15s.
3. **Local AI** — Save Ollama Base URL in UI (`POST /ai/local/base-url`); force refresh; clear offline hint; pull uses force probe once.
4. **Chat routing** — use discovered models only when present (stops 404 on catalog defaults like missing Groq model ids).
5. **Local key** — not recreated after user deletes it.
6. **Gateway** — App Builder path unchanged; discovery still documents Docker DNS.

## Local download still needs host Ollama
Hub cannot invent Ollama. Install Ollama on SoloHost host, bind 0.0.0.0:11434, set URL `http://host.docker.internal:11434` (or LAN IP), Save URL → Refresh → Download.

## Tests
node test.js PASS (cache + chat + gateway token)
