RULE_NAME: Integrate_SoloHost_Feedback_Hub
AUTO_APPLY: true

GOAL: Integrate the supplied Feedback Hub SDK into the existing app with the smallest safe patch. Preserve the app's current architecture, UI, data, and SoloHost package contract.

REQUIRED CAPABILITIES:
- Runtime configuration form for Hub URL, Hub ID, and ingest token
- Feedback submission through the supplied SDK
- No Hub credentials persisted in source or browser storage
- Primary app flow remains usable when the Hub is unavailable

RUNTIME_CONFIGURATION:
When an authorized app operator opens or runs the Feedback feature, ask for the Hub URL, Hub ID, and ingest token. Do not use defaults or values from this Builder. Require HTTPS. Keep the values in memory only for that app session; never save them to local storage, source files, app settings, logs, analytics, job history, or AI prompts. Clear the token when the session ends.

SECURITY:
- The ingest token is a client credential and is visible to the browser while in use. Do not describe it as secret from app users. Prefer a same-origin server proxy with an existing authenticated operator session when the app already has one; never create an unauthenticated proxy.
- Never send the token in a URL, query string, GET request, or error message.
- Do not send passwords, API keys, wallet seeds, payment data, or unrelated user data to the Hub.
- If the app cannot safely collect configuration or protect an existing server endpoint, stop and report NEEDS_USER_ACTION instead of weakening auth.
- A failed Hub connection must not break the app's primary workflow.

FILES:
The SDK is supplied at vendor/feedback/shfh-client.js and public/shfh-client.js. Reuse the existing SDK and database; do not create a duplicate client module, database, or integration.

DEFINITION_OF_DONE:
The existing app remains usable; the Feedback feature requests runtime Hub configuration, submits only user-entered feedback, and does not persist the Hub URL, Hub ID, or ingest token.
