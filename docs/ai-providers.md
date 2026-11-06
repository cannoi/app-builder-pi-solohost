# AI providers

`AIGateway` talks to adapters:

- `GeminiProvider`
- `DeepSeekProvider`

The router picks a provider from the task type and the configured primary. Failures are recorded. A fallback is visible to the user and never silent.

Do not hard-code model names in business logic. Set `GEMINI_MODEL` and `DEEPSEEK_MODEL` in `.env`.
