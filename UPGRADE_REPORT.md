# Personal AI Hub — Recovery & Hub Upgrade Report

## Primary incident fixed
Observed production symptom:
- `token.added` was logged, but chat immediately returned `NO_ACTIVE_KEY`.
- This happened because key activation depended on a frontend follow-up test. If that UI step was skipped, interrupted, or an older frontend was running, the key remained `TEST_REQUIRED` and the server refused to use it.

### Fix
1. Provider keys are now verified server-side immediately after creation.
2. Chat automatically attempts bounded verification of pending/temporary keys before returning `NO_ACTIVE_KEY`.
3. Existing `TEST_REQUIRED` keys from older state files can therefore recover without re-entering the token.
4. Invalid/auth-failed keys remain blocked until explicitly re-tested/replaced.

## Multi-provider / multi-token
- Multiple encrypted tokens per provider are supported.
- Every token stores an immutable provider ID.
- Routing only selects tokens belonging to the requested provider.
- Key selection prefers the least-used eligible token and respects cooldowns.
- Authentication errors become `INVALID`; rate limits become `COOLDOWN`; transient errors become `ERROR` with bounded retry delay.

## Model discovery
- Models are discovered through the provider associated with each token.
- Gemini discovery filters to models advertising `generateContent`.
- OpenAI-compatible discovery removes obvious non-chat model families such as embeddings, moderation, TTS, image and transcription models.
- Chat model selection is derived from active token/provider capability rather than one global hard-coded list.

## Logging / diagnostics
Settings contains Activity Log with:
- AI requests and request IDs
- token add/verify lifecycle
- provider/model attempts
- fallback/failure reasons
- local AI health/download events
- memory events
- API errors

Logs auto-refresh while Settings is open. Secret fields are redacted, while non-secret `keyId` values remain visible for troubleshooting.

## SoloHost AI Gateway
The same unified execution plane is exposed through:
- `/ai/*` for Hub UI/internal control
- `/api/v1/*` for SoloHost app integrations

`X-SoloHost-App-ID` is captured as diagnostic context without exposing credentials.

## Local AI
- Ollama is treated as a provider capability rather than a cloud credential.
- A virtual local key is created automatically and can be health-checked.
- Ollama base URL can be configured with `OLLAMA_BASE_URL` or `OLLAMA_HOST`; otherwise it defaults to `http://127.0.0.1:11434`.
- Model list/pull/chat use the same unified kernel path.

## Security
- Provider credentials remain AES-256-GCM encrypted.
- Generated master key is runtime state and is no longer shipped in the release ZIP.
- Runtime data is ignored by `.gitignore`.
- Logs do not redact ordinary diagnostic IDs such as `keyId`, but redact credential/token/authorization/secret/password fields.

## Verification
- All repository JavaScript files: syntax PASS.
- All inline frontend JavaScript blocks: syntax PASS.
- `npm test`: PASS — core integration + pending-key recovery.
- Secret scan: PASS for common API-key patterns in shipped source.
- Release archive integrity: verified with `unzip -t`.

## Not fully verifiable in build environment
Live cloud-provider execution with the user's real credentials cannot be certified without those credentials and network access to the provider. The integration suite uses deterministic provider responses to verify the complete encrypted-token → provider → model → response pipeline.

Local Ollama execution also depends on an Ollama service reachable from the SoloHost container. A `fetch failed` local health event is therefore a real infrastructure/network state, not silently treated as a healthy model runtime.
