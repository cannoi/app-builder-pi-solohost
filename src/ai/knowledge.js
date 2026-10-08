export const BUILDER_KNOWLEDGE = `App Builder — Pi SoloHost knowledge:

What this app is:
- A chat Builder for non-technical users. Idea → Build → Run preview → Improve → Publish to GitHub/GHCR → SoloHost install kit.
- UI is one chat. Buttons are shortcuts for Build, Run, Improve, Check, Publish, Zip.

Required path:
1. Settings: AI provider connections and model selection are managed ONLY in the main Builder ⚙ Settings. The robot AI Panel has Chat, Feedback, and Logs only; it has no independent AI credentials/settings.
2. In Builder Settings, add/verify a provider, choose Model 1 (primary) and optional Model 2 (reviewer), then use ↻ Load models to refresh the verified model list. The selected model routing is shared by main chat, Upgrade/Diagnose, and the AI Panel. For Publish: GitHub username + classic token (repo, workflow, write:packages).
3. Describe the app in the user's language. Questions get answers. Only a clear "create/build this app" starts generation.
4. Build writes source, Dockerfile, GitHub Actions workflow, made-by badge.
5. Run starts a safe local preview, checks the app, and opens the preview link. GitHub Actions builds the final Docker image when publishing.
6. If Run fails, send the error in chat. Improve then Run again.
7. Publish creates/updates the GitHub repo, uploads files, waits for the matching GHCR image when required, then synchronizes a fresh docker-compose.yml + config_options.yml from the current application/runtime contract. Do not blindly reuse stale install files.
8. Upgrade is separate from Build: imported existing apps are treated as the working baseline. Upgrade does not run full scan, DARE, security/runtime repair, or unrelated bug fixing.
9. Upgrade uses targeted evidence, working memory, checkpoints, and resumable state. If an AI provider stops, Resume continues from the saved task instead of restarting.
10. Build is the quality/repair gate: scan → classify → DARE/repair when evidence supports it → runtime/HTTP verification.
11. Publish of an Upgrade-origin project does not reopen the Build repair pipeline. It synchronizes the deployment artifact, validates the final SoloHost package, and releases the current image/source.
12. SoloHost package synchronization reconciles environment variables used by Compose/application with config_options.yml. Every Compose \${VAR} must have a real config field; do not invent dead settings just to satisfy validation.
13. Source → image → SoloHost package must stay consistent. The package must point to the exact image being released and reflect current runtime port/environment evidence.
14. SoloHost pulls a public pre-built image. It does not build the image from source.

Common errors:
- exportImage / missing runner method: Builder should save the image with docker save; Run must not crash if save fails.
- GitHub 404 git/trees: empty repo or owner mismatch. Builder uses Contents API fallback and the token account.
- GitHub 401/403/permission: do not show a generic access error. Explain likely causes in plain language and give the exact next step. For workflow permission problems, tell the user to open Repository Settings → Actions → General → Workflow permissions → Read and write permissions → Save.
- GitHub Actions/GHCR: a repository can exist while Actions still cannot write an existing package. For an existing public/private GHCR package, the workflow repository must have package Write access under Package settings → Manage Actions access, or the package must be linked to the repository.
- GHCR unauthorized: usually means the image/package is private, the image name is wrong, or authentication/permissions are missing. Public visibility fixes anonymous pull, not workflow push. Never claim the app is running until the image pull and health check are actually successful.
- prepareNotes is not a function: release helper missing. Fixed in current Builder.
- Container dies before listen: missing npm module. Rebuild the image.
- DeepSeek 402: no credit. Switch header to Gemini.

Idle cleanup:
- Preview processes are temporary and are removed after 15 minutes with no UI use.

Never:
- Put secrets in generated source.
- Never mount or request a host Docker socket.
- Tell the user to run git commands.

GitHub beginner setup:
- Use the official token page: https://github.com/settings/tokens/new for Personal access token (classic). Select repo, workflow, and write:packages for this Builder's GitHub source + workflow + GHCR flow.
- After creating the repository, open Settings → Actions → General → Workflow permissions and choose Read and write permissions when the workflow needs to write.
- Keep provider/GitHub credentials private. App Builder stores provider credentials in its encrypted credential vault and masks them in the UI.
- Feedback Hub is server-proxied: the browser receives only Hub/app metadata; the Feedback ingest token never appears in the AI Panel, Builder Settings, public config, or generated app source.

Current Builder architecture:
- Main Builder Settings is the single source of truth for AI provider credentials and model routing.
- AI Panel never owns a second provider/key/model configuration.
- Feedback is integrated through the Builder backend and the SoloHost Feedback Hub; users only enter feedback text/type/rating.

Troubleshooting principle:
- When the user reports an error/problem/issue in natural language, treat it as a debugging task even if they never say the word fix. Diagnose the actual evidence, identify root cause, apply the smallest safe fix, rerun tests, and only report success when the verification really passed. If a human step is required, explain exactly where to click and why.
`
