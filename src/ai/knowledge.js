export const BUILDER_KNOWLEDGE = `App Builder — Pi SoloHost knowledge:

What this app is:
- A chat Builder for non-technical users. Idea → Build → Run preview → Improve → Publish to GitHub/GHCR → SoloHost install kit.
- UI is one chat. Buttons are shortcuts for Build, Run, Improve, Check, Publish, Zip.

Required path:
1. Settings: DeepSeek or Gemini key. For Publish: GitHub username + classic token (repo, workflow, write:packages).
2. Describe the app in the user's language. Questions get answers. Only a clear "create/build this app" starts generation.
3. Build writes source, Dockerfile, GitHub Actions workflow, made-by badge.
4. Run starts a safe local preview, checks the app, and opens the preview link. GitHub Actions builds the final Docker image when publishing.
5. If Run fails, send the error in chat. Improve then Run again.
6. Publish creates/updates the GitHub repo, uploads files, and prepares docker-compose.yml + config_options.yml. Do not install on SoloHost until the GHCR image exists.
7. SoloHost pulls a public image. It never builds from source. Every service in docker-compose.yml must use image:; do not ship build:.
8. A SoloHost package is only docker-compose.yml + config_options.yml. Keep the package minimal; application source stays in the published image.
9. The UI service must have exactly one pi.ui.primary: "true" label and exactly one loopback port 127.0.0.1:HOST:CONTAINER. HOST should be distinctive/high; CONTAINER must be the port the image actually serves. Never assume 8080.
10. Passing validation is necessary but not sufficient for rendering. Verify the app actually listens on the packaged container port and returns HTTP there. SoloHost has a readiness probe; blank/502 UI is a runtime/readiness problem.
11. Use the authoritative SoloHost validator before handing the install kit to the user. Fix validator errors before export.
12. Prefer immutable/versioned image tags instead of :latest for release packages.
13. If the app persists data, use named volumes; never use host bind mounts. Installer fields must map to environment variables the image actually reads.
14. Do not invent config_options.yml keys. It has a strict closed schema. Every $\{VAR\} used by compose must be declared by fields or fixed_values.

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
- Keep the token private. App Builder stores it in runtime configuration and masks it in the UI.

Troubleshooting principle:
- When the user reports an error/problem/issue in natural language, treat it as a debugging task even if they never say the word fix. Diagnose the actual evidence, identify root cause, apply the smallest safe fix, rerun tests, and only report success when the verification really passed. If a human step is required, explain exactly where to click and why.
`
