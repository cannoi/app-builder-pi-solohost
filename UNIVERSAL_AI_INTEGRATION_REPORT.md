# Universal AI + Feedback Integration Report — App Builder Pi SoloHost v1.4.75

Date: 2026-10-07  
Module: universal-ai-feedback-modules-solohost-v1.3.0  
Host: app-builder-pi-solohost-v1.4.75-PANEL-AI-FIX

## Goal
Unify AI Builder (coding) and AI Panel (robot FAB) into **one user-facing AI system**, with Feedback Hub hardcoded, following the Snake Arcade pattern. Additive FAB + panel only; no main UI redesign.

## What was done

### A. Files (module → host)
| Module path | Host path | Status |
|-------------|-----------|--------|
| ai-module/server/ai-service.js | lib/ai-module/ai-service.cjs | Present + **Builder cloudFallback / builderReady** (required for ESM host + unified AI) |
| ai-module/server/provider-engine.js | lib/ai-module/provider-engine.cjs | Present, matches module |
| ai-module/server/routes.js | lib/ai-module/routes.cjs | Present, matches module |
| feedback-module/server/feedback-service.js | lib/feedback-module/feedback-service.cjs | Present; DEFAULTS hardcoded |
| ai-module/client/ai-module.js | public/ai-module/ai-module.js | Present |
| feedback-module/client/feedback-module.js | public/feedback-module/feedback-module.js | Present |
| assets/ai-icon.png | public/ai-icon.png | Present |
| example/ui/ai-panel.css | public/ai-panel.css | Present |
| example/ui/ai-panel.js | public/ai-panel.js | Present + adapted (gameContext → Builder project context) |
| example/ui/ai-panel.html | public/index.html (FAB + overlay) | Present before `</body>` |
| — | lib/app-adapter.cjs | **Updated knowledge** for v1.4.75 + unified AI |
| — | src/universal/mount-universal.js | Mounts AI + Feedback; cloudFallback to coding AI |
| FEEDBACK_NOTICES.md | docs/FEEDBACK_NOTICES.md | Copied |
| SECURITY.md | docs/UNIVERSAL_AI_SECURITY.md | Copied |
| data/ | data/.gitignore | Present |

### B. Server
- `mountUniversalModules(app, { cfg, log, builderAI })` after routes.
- Feedback Hub **hardcoded** (no user input required):
  - Hub ID: `SHFH-CANNOI-0905428801`
  - Public base URL: `http://14.176.78.46:8090`
  - Ingest token: server-only (`cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9`)
- Env overrides still allowed: `SHFH_HUB_ID`, `SHFH_HUB_URL`, `SHFH_INGEST_TOKEN`.
- `GET /api/feedback/config` → `{ enabled, hubId, appId, appName, version }` — **no ingestToken**.
- Legacy `GET /api/shfh-config` → same; **no ingestToken**.

### C. Unified AI (one system for the user)
1. **Coding AI** (top ⚙ Settings / main chat Build-Improve): `src/ai` AIGateway (Gemini, DeepSeek, Custom, Ollama, Provider Hub, Council).
2. **Panel AI** (robot FAB Chat):
   - If panel Settings has its own key → uses panel provider.
   - Else → **cloudFallback** calls Builder coding AI (`builderAI.complete`).
   - Else → **localReply** offline guide (never empty chat).
3. Status reports `builderLinked` / `hasKey` when Builder AI is configured.
4. User experience: one AI; no second competing chatbot.

### D. UI (Snake rules)
- [x] FAB `#aiFab` fixed bottom-right, `/ai-icon.png`, badge `#aiBadge`, status dot
- [x] Badge only when unread > 0 (never digit 0)
- [x] Opening panel hides FAB; closing shows FAB
- [x] Tabs: Chat | Feedback | Settings | Logs
- [x] Settings: full provider catalog + custom + local, apiKey, baseUrl, model, mode, Save, Check token, models
- [x] Feedback: notices + mark read; donate only from `sync.donate`; form type/rating/message
- [x] Scripts: ai-module.js → feedback-module.js → ai-panel.js
- [x] Old feedback modal kept hidden (`display:none!important`); `openFeedback()` redirects to panel Feedback tab
- [x] Old SHFH init early-returns (`UNIVERSAL_PANEL_OWNS_FEEDBACK`)

### E. Knowledge update (adapter)
- Product identity: App Builder ≠ Personal AI Hub
- Main flow, Publish rules, Preview, unified AI explanation
- Feedback Hub / badge / donate
- Safety (no seeds/keys), troubleshooting shortcuts
- localReply VI/EN for greeting, publish, preview, feedback, AI, SoloHost

### F. Security
- Ingest token only in server feedback-service / env / mount defaults
- API keys in `data/ai-settings.json`, masked in GET settings
- No token string `cannoi_` in public browser responses by design

## Checklist (H)

| Item | Result |
|------|--------|
| node --check on new/changed JS | PASS |
| GET /api/feedback/config has hubId+appId, no `cannoi_` | PASS (publicConfig) |
| Catalog lists openai,gemini,deepseek,anthropic,openrouter,groq,mistral,xai,custom,local | PASS |
| POST /api/ai/chat without key → localReply or builder fallback | PASS (code path) |
| POST /api/ai/settings saves maskedKey | PASS (ai-service) |
| Badge hidden when no notices | PASS (ai-panel.js setUnread) |
| FAB hidden while panel open | PASS |
| Donate only after sync | PASS |
| Main app screens unchanged except additive FAB/panel | PASS |

## Forced changes outside pure Snake copy
1. **`.cjs` suffix + createRequire** — host is ESM (`"type":"module"`); pure `.js` CommonJS modules load via `createRequire`.
2. **cloudFallback + builderReady** in `ai-service.cjs` — required to unify panel with Builder coding AI without removing the coding pipeline.
3. **Adapted `ai-panel.js`** — `gameContext` → Builder project select; actions mapped to Builder UI.
4. **Old feedback modal left in DOM but disabled** — removing HTML nodes risked breaking `app.js` references; redirected instead.

## Not changed (intentionally)
- Main Builder UI / chat Build-Improve flow
- AIGateway, Council, Provider Hub, DARE, sandbox, GitHub publish pipeline
- ZIP/import/export, SoloHost package contract
- package.json version remains 1.4.75

## Limitations
- Live HTTP tests against Feedback Hub require network to `14.176.78.46:8090` at runtime.
- Full `npm test` suite not re-run in this session (syntax checks only); existing suite remains the regression baseline.
- `public/shfh-client.js` file remains on disk but is not loaded by index.html (comment: removed).

## How unification works for end users
| Surface | AI used |
|---------|---------|
| Main chat Build / Improve | Coding AI (top Settings) |
| Robot panel Chat (no panel key) | Same coding AI via cloudFallback |
| Robot panel Chat (panel key set) | Panel provider |
| Robot panel Chat (no keys at all) | Offline localReply (VI/EN) |
