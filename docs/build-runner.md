# Build and Preview Runner

The preview flow is:

1. Validate the generated source.
2. Detect the app type automatically. Real container apps use the protected `PODMAN_API_URL` Sandbox when the platform provides it; ordinary Node/static apps stay on native preview.
3. Build a temporary preview image through the protected Podman API.
4. Start a temporary container with CPU/memory limits and a loopback-only port.
5. Wait for `/health` and run Playwright against the live UI.
6. Keep the container only for an explicit live Run; test-only runs tear it down.
7. If `auto` mode cannot use the Container Sandbox, fall back to native preview and report the runtime used.
8. Never use a host Docker socket.

Every saved test result and live preview is tied to a fingerprint of the current project source. Repair and Upgrade verify the files in the canonical project `source` directory; chat-triggered changes use the same verification record as direct Improve actions. A release is blocked if either the latest checks or preview belong to an older source fingerprint. Run Check and then Run against the updated files before publishing.

The Upgrade Workshop first records a source and test baseline, including JavaScript syntax and security findings. It then applies the user's requested upgrade automatically, checks the exact changed-file manifest, syntax-checks changed JavaScript, and compares final security/static/test results against the baseline. A failed patch is rolled back before at most two evidence-based AI repair attempts; repeated patches stop safely. Each successful upgrade retains a checkpoint for user rollback. The Builder asks for input only when a required credential or consequential decision cannot be safely inferred.

GitHub Actions remains responsible for the final published SoloHost image.
