# Personal AI Hub — Recovery Release

- Fixed server-side AI key activation so `token.added` cannot leave a usable key stuck at `TEST_REQUIRED`.
- Added automatic recovery/testing of pending keys before `NO_ACTIVE_KEY`.
- Improved multi-token provider routing and cooldown handling.
- Improved provider-specific model discovery and chat-model filtering.
- Added `/api/v1/*` SoloHost gateway aliases to the unified AI execution plane.
- Added automatic local Ollama capability registration and configurable Ollama endpoint support.
- Improved Activity Log diagnostics and secret redaction.
- Added live Settings log refresh and clearer key health/model information in the UI.
- Removed generated runtime master-key material from the release package.
- Added regression coverage for pending-key recovery.
