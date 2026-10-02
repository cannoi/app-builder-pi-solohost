# AI App Kernel v1.1.4

Patch: key isolation (no cross-provider secret leak); token auto-detect, /ai/act invoke fix, Gemini normalize, fallback + discovery. See FIX_REPORT.md.

# AI App Kernel

Portable AI controller for any Node app.

The app keeps its architecture. This module only:

- talks to an AI provider
- auto-picks provider/model from available API tokens (high → low)
- remembers the last working model (sticky) so it does not hop every call
- supports local OpenAI-compatible servers (Ollama, LM Studio, custom)
- reads a declared data schema
- reads/writes data through a store adapter
- calls registered app actions

## Install

Copy this folder into your project. No required npm dependencies (Node 18+ `fetch`).

```js
import { createAiKernel, createActionRegistry, createJsonFileStore, createCustomStore } from './ai-app-kernel/src/index.js';
```

## 1. Describe data

```js
const schema = {
  name: 'my-app',
  collections: [
    { name: 'tasks', fields: ['id', 'title', 'done'] },
  ],
};
```

## 2. Connect your database

JSON file:

```js
const store = createJsonFileStore('./data/app.json', { tasks: [] });
```

Existing DB:

```js
const store = createCustomStore({
  listCollections: async () => ['tasks'],
  list: async (name, filter) => db.find(name, filter),
  get: async (name, id) => db.findOne(name, id),
  put: async (name, record) => db.upsert(name, record),
  delete: async (name, id) => db.remove(name, id),
});
```

## 3. Register app functions

```js
const actions = createActionRegistry()
  .register({
    name: 'complete_task',
    description: 'Mark a task done',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id }) { return app.completeTask(id); },
  });
```

## 4. Start kernel

You do **not** need to pass `provider` / `model` unless you want to lock them.

```js
const ai = createAiKernel({
  schema,
  store,
  actions,
});

ai.mount(expressApp, '/ai', {
  authorize: async (req) => Boolean(req.user?.isOperator),
});
```

Env:

- `AI_PROVIDER` openai | gemini | deepseek | groq | openrouter | mistral | xai | ollama | lmstudio | local | custom
  Optional. If omitted, kernel ranks tokens high → low: xai, openai, gemini, openrouter, mistral, deepseek, groq, then local.
- `AI_MODEL` optional lock. If omitted, kernel uses the sticky last-good model, else the first default for that provider.
- `AI_API_KEY` or `OPENAI_API_KEY` / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` / `XAI_API_KEY` / `GROQ_API_KEY` / ...
- Local: `LOCAL_AI_BASE_URL` or `OLLAMA_BASE_URL` or `LMSTUDIO_BASE_URL` (OpenAI-compatible `/v1/chat/completions`). Local providers do not require a real API key.
- `AI_STICKY_FILE` path to remember last working provider+model (default `./.ai-kernel-sticky.json`). After 2 failures the kernel leaves that sticky pair.

Token shape is also used as a hint (`gsk_` → groq, `sk-or-` → openrouter, `xai-` → xAI, `AIza` → gemini, `sk-` → openai).

## Standard tools the model can call

| Tool | Purpose |
|---|---|
| app_schema | read collections |
| app_capabilities | list actions |
| db_list / db_get / db_put / db_delete | data |
| app_invoke | run a registered function |

## HTTP

- `GET /ai/schema`
- `GET /ai/capabilities`
- `GET /ai/route` current auto-selected provider/model
- `GET /ai/logo.png` AI button logo
- `POST /ai/chat` `{ "message": "list open tasks" }`
- `POST /ai/act` `{ "name": "complete_task", "args": { "id": "1" } }`

All routes except `/ai/health` require the host app's authorization callback. Reads and writes are limited to the declared collection and field allowlists; records are projected to those fields.

Button snippet:

```js
import { aiButtonHtml } from './ai-app-kernel/src/http.js';
res.send(aiButtonHtml({ prefix: '/ai' }));
```

Give `INTEGRATE.md` to another coding AI to attach this module to an existing app.
