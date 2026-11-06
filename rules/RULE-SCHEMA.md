# App Builder Rule Format

A `.rule` file is a reusable upgrade contract, not a one-shot command.

## Required

- `RULE_VERSION`
- `RULE_NAME`
- `APP_TYPE`
- `TARGET`
- `GOAL`
- `REQUIRED CAPABILITIES`

## Optional

- `OPTIONAL CAPABILITIES`
- `PHASES` — ordered goals Builder should work through.
- `FUNCTIONAL ACCEPTANCE` — observable checks that must be verified.
- `REQUIRED SECRETS` / `SECRETS` — names only; never put secret values in the rule.
- `QUESTIONS` — user choices/configuration Builder must request before continuing.
- `STOP CONDITIONS` — conditions that require stopping instead of guessing.
- `MAX CYCLES` — bounded rule execution, default 3, maximum 6.
- `AUTO_REPAIR` — `true` for low-risk bounded automatic repairs, `false` for guided mode.

## Secrets

Rules must contain **secret names only**, for example:

```text
SECRETS:
YOUTUBE_API_KEY
```

Never place an API key, token, password, wallet credential, private key, or GitHub token in a Rule file.
Builder must request required configuration through the app's secure settings/configuration flow and must never write the secret into source code, Git history, Rule history, or AI prompts.

## Execution model

```text
Load Rule
→ Inspect project
→ Detect capability gaps
→ Ask required user questions/configuration
→ Plan smallest change
→ Apply only safe/approved changes
→ Build
→ Start
→ Health
→ Functional verification
→ Re-check Rule
→ Repeat with a bounded cycle limit
→ Complete / Needs user action / Stop safely
```

The same failed repair must never be repeated without new evidence.
