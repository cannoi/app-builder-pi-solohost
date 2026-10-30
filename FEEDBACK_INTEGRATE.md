# Integrate SoloHost Feedback Hub

Use this prompt with any coding AI. Do not rewrite the app.

```
Integrate SoloHost Feedback Hub into this existing app. Minimal change only.

SDK
- Copy shfh-client.js to public/shfh-client.js (browser + Node export: window.SHFH.create).
- Load order: <hubUrl>/api/sdk.js if the page is not HTTPS calling HTTP, else /shfh-client.js.
- If neither loads, the Feedback button opens <hubUrl>/feedback.

Server config (no user setup)
GET /api/shfh-config returns:
{
  hubId, hubUrl, formUrl, ingestToken, appId, appName, version, platform: "solohost", enabled
}
Defaults may be built in. Env overrides: SHFH_HUB_URL, SHFH_INGEST_TOKEN, SHFH_APP_ID, SHFH_APP_NAME, SHFH_ENABLED=0.

Client
const hub = SHFH.create({ hubUrl, ingestToken, appId, appName, version, platform: "solohost", locale });
await hub.sync();
await hub.sendFeedback({ type: "bug"|"improvement"|"question", message, rating });
await hub.reportPayment({ txn_id, method, amount, state });
hub.markUpdateSeen(id); hub.markRead(id);

Rules
- Send only what the user types. Never send passwords, API keys, or wallet seeds.
- ingestToken is a client token; it is visible in the browser by design.
- If the page is HTTPS and the Hub is HTTP, post feedback through the same-origin server proxy so mixed content does not block it. The proxy must send Authorization: Bearer <ingestToken>.
- Queue locally if the Hub is offline (SDK already does this).
- UI labels stay short English. Chat/notices may follow the user language.
- Do not change unrelated features.
```

Reference app that already works: Snake Arcade (`public/feedback.js`, `GET /api/shfh-config`).
Hub: `http://14.176.78.46:8090` · app id for Builder: `app-builder-pi-solohost`.
