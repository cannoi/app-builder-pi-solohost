# INTEGRATE AI APP KERNEL — prompt for another AI

Copy this block into any coding AI with your app source.

```
Add the portable module "ai-app-kernel" to this application.

GOAL
Let a user chat with AI to read/write this app's data and call this app's functions.
Do not rewrite the app. Minimal patch only.

STEPS
1. Copy the folder ai-app-kernel into the project (keep its src/ intact).
2. Detect the app architecture: Express / Fastify / plain Node / other.
3. Detect the database: SQLite / Postgres / Mongo / JSON file / memory / custom.
4. Create one adapter with createCustomStore({ listCollections, list, get, put, delete }) if the app already has a DB layer. Map to existing repositories. Do not add a second database.
5. Register real app actions with createActionRegistry().register({ name, description, parameters, run }).
   run() must call existing app services, not duplicate business logic.
6. Describe schema: collections/tables and fields that AI may touch. Do not include secrets tables.
7. createAiKernel({ provider, schema, store, actions }) and mount HTTP:
   GET  /ai/health
   GET  /ai/schema
   GET  /ai/capabilities
   POST /ai/chat   { message, history }
   POST /ai/act    { name, args }
8. Keys come from env: AI_PROVIDER, AI_MODEL, AI_API_KEY or PROVIDER_API_KEY. Never log keys.
9. Add a small chat box only if the app has no chat UI. Keep English UI labels short.
10. Pass the host app's existing authorization callback to `kernel.mount(app, '/ai', { authorize })`. The callback must return `true` only for an authenticated operator. Without it, protected routes fail closed.
11. Verify: schema lists only allowlisted collections and fields; a database read and one app action work for an authorized request; chat replies in the user language.

CONSTRAINTS
- Do not expose host/Docker/system commands.
- Do not allow AI to drop tables or delete the whole database.
- Allowlist collections in schema.
- Preserve existing routes, auth, and data.
```
