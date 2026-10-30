# GitHub

Required: `GITHUB_TOKEN`, `GITHUB_OWNER`.

Flow: scan → create private repo → git blobs/tree/commit → `main` → optional tagged release.

`.env` files are skipped. Critical scanner hits block the push.

## Safe publish verification

The publisher now uses the current `main` head as the commit parent, updates the branch without force, retries a head race, mirrors deleted files, and verifies the remote tree after publishing. Container release verification checks that the exact GHCR tag exists before the release is marked complete.

## Release recovery
If a GitHub publish or GHCR verification step fails, the release pipeline asks the configured AI provider for a short diagnosis and next action in the user's language. The AI does not receive permission to bypass the deterministic publish/verification gates.

## Beginner GitHub access guide

There are two Personal Access Token types: **fine-grained** and **classic**. For this Builder's current GitHub + Actions + GHCR workflow, the guided path uses **Personal access token (classic)**.

Create it here:

`https://github.com/settings/tokens/new`

Select:
- `repo`
- `workflow`
- `write:packages`

Then paste the token into App Builder Settings → GitHub token. Never put it into app source code.

If GitHub reports that Actions is read-only:
1. Open the repository on GitHub.
2. Open **Settings → Actions → General**.
3. Under **Workflow permissions**, select **Read and write permissions**.
4. Save.
5. Return to Builder and Publish again.

Fine-grained tokens are supported by GitHub and are more restrictive, but their repository/permission selection is more detailed. If a fine-grained token is used, it must be granted the permissions required by the exact API operations and may require organization approval.
