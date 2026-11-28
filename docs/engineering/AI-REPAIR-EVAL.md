# AI Repair Evaluation — v1.11.0

Status: **NOT_TESTED** · Platform: `linux/x64` · Node: `22.23.5`

| Case | Status | Detail |
|---|---|---|
| syntax-error | NOT_TESTED | No GEMINI_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY configured |
| ui-calls-missing-api | NOT_TESTED | No GEMINI_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY configured |
| crash-on-start | NOT_TESTED | No GEMINI_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY configured |

To execute against a real provider:

```bash
GEMINI_API_KEY=... npm run eval:ai-repair -- --write-doc --json eval-ai.json
```
