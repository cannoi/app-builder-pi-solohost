RULE_NAME: Integrate_SoloHost_Feedback_Hub
AUTO_APPLY: true

GOAL: Integrate the supplied Feedback Hub SDK into the existing app with the smallest safe patch. Preserve the app's current architecture, UI, data, and SoloHost package contract.

REQUIRED CAPABILITIES:
- Feedback submission through the supplied SDK
- Read SHFH_HUB_URL, SHFH_HUB_ID, and SHFH_INGEST_TOKEN from server runtime environment
- Declare those variables in SoloHost config_options.yml and reference them from docker-compose.yml
- Keep credentials out of app source, GitHub, ZIP files, browser code, and user-facing UI
- Primary app flow remains usable when the Hub is unavailable

RUNTIME_CONFIGURATION:
The app owner configures the three SHFH_* values once in SoloHost's config_options form. Use empty environment references in Compose; never add credential values or credential defaults to source. Hub URL must be HTTPS. Do not ask app users for Hub settings, display them in the UI, or return them from an API. If the project cannot safely provide its existing authenticated server route and runtime environment, stop with NEEDS_USER_ACTION.

INTEGRATION:
Use the supplied SDK from the server side to create and send feedback. The browser may submit only the bounded feedback type and message to an existing authorized app route. Add only missing config_options.yml fields (SHFH_HUB_URL and SHFH_HUB_ID as text; SHFH_INGEST_TOKEN as password) and empty docker-compose.yml environment references using ${VAR:-}. Never put actual values or defaults in either file.

SECURITY:
- Keep the ingest token server-side. Submit feedback through the app's existing authenticated server route and call the Hub from that server; never send the token to a browser.
- Never send the token in a URL, query string, GET request, response, log, or error message.
- Do not send passwords, API keys, wallet seeds, payment data, or unrelated user data to the Hub.
- Do not add a public unauthenticated proxy or weaken existing authorization. If feedback submission cannot be protected by existing app authorization, stop and report NEEDS_USER_ACTION.
- A failed Hub connection must not break the app's primary workflow.
- Accept only a bounded feedback message and an allowlisted feedback type; do not proxy arbitrary URLs or methods.

FILES:
The SDK is supplied at vendor/feedback/shfh-client.js and public/shfh-client.js. Reuse the existing SDK and database; do not create a duplicate client module, database, or integration.

DEFINITION_OF_DONE:
The existing app remains usable; only an authorized app user can submit feedback; the server reads the three Hub values from environment; SoloHost presents the values only to the app owner during setup; no credential value is committed or included in a ZIP.
