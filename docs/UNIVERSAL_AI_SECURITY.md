# SECURITY NOTES

1. The Feedback Hub ingest token is server-side only.
2. The browser never receives the ingest token.
3. AI API keys are stored server-side with file mode 0600.
4. Logs are redacted for key/token/password/authorization fields.
5. AI actions are allowlisted by the server-side host adapter; browser-supplied action definitions are ignored.
6. Destructive actions require host-side confirmation.
7. The AI model is not trusted code.
8. The AI model is not trusted code.
9. Never expose `.env`, `process.env`, cookies, sessions or filesystem secrets through app context.
10. Do not give the AI shell, Docker, arbitrary HTTP, SQL, or filesystem write tools.
11. If this ZIP/source is published publicly, rotate the Feedback Hub ingest token and replace the built-in default.

## Network

The default Hub endpoint is HTTP because that is the endpoint supplied for this project. For public deployment, HTTPS is strongly preferred. If the Hub remains HTTP, the ingest token is protected from the browser but is still transported over the network to the Hub; use a secure reverse proxy/tunnel or HTTPS Hub endpoint when possible.
