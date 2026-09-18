# Changelog

## 1.4.8

- GitHub owner comes from GET /user, not Settings guess.
- Source publish uses a temp git worktree: init, add, commit, branch -M main, push.
- 401/403 stop immediately. Network errors retry at most twice.
- GHCR is a separate stage. GitHub source success is not rolled back if GHCR is late.
- Failed GitHub publish offers Download Project plus web upload steps.


## v1.4.8 — reliability upgrade
- Natural-language problem reports now route into debugging instead of requiring the word "fix".
- GitHub failures now produce beginner-friendly diagnosis and exact setup guidance, including token type/scopes and Actions workflow permissions.
- Publish checks for existing repositories and asks before overwrite or creating a new repository.
- GHCR unauthorized and GitHub workflow read-only failures are treated as access/configuration problems, not app-code failures.
- SoloHost release validation uses the official hosted validator when network access is available.
- Release descriptions can be AI-written into 3–5 short English lines.
- API keys, tokens, IDs and operator settings are supported through config_options.yml instead of hard-coded values.
- Existing features and version remain unchanged.
