# Device verification — v1.11.0

Run on the real device (Pi / SoloHost container):

```bash
docker exec -it <app-builder-container> npm run verify:device
# or, from a checkout:  npm run verify:device -- --out verify-device.json
```

It checks Node >= 22, non-root user, no Docker socket, the controlled executor (`node.check`, `npm test`, process-group kill), Chromium detection and one real runtime + browser validation of `std-business-crm` from a temp copy. It never touches user projects.

## Sandbox run (v1.11.0, 2026-11-24) — NOT a Pi

Overall: **WARNING**

| Check | Status | Detail |
|---|---|---|
| builder.version | PASS | 1.11.0 · flag=shadow |
| node.version | PASS | node 22.23.5 (needs >= 22) |
| platform | PASS | linux/x64 · 2 CPU · 4096 MB RAM |
| process.user | WARNING | running as root (container should be non-root) |
| docker.socket | PASS | not mounted |
| executor.node_check | PASS | 132 ms |
| executor.npm_test | PASS | 314 ms |
| executor.group_kill | PASS | process group terminated on stop |
| browser.chromium | NOT_AVAILABLE | browser QA will report NOT_AVAILABLE (honest), never PASS |
| validation.runtime | PASS | WARNING in 676 ms · start=PASS health=PASS browser=NOT_TESTED |

`process.user` is `WARNING` because this development sandbox runs as `root`; the shipped Docker image runs as `USER node`. `browser.chromium` is `NOT_AVAILABLE` because Chromium is not installed in this development container (`auto` mode therefore stays `shadow` cleanly).

## Previous sandbox run (v1.10.0, 2026-11-23) — NOT a Pi

| Check | Status | Detail |
|---|---|---|
| builder.version | PASS | 1.10.0 · flag=shadow |
| platform | PASS | linux/x64 · 16 CPU · 32768 MB RAM |
| browser.chromium | PASS | /usr/bin/chromium-browser |
| validation.runtime | PASS | WARNING in 5411 ms · start=PASS health=PASS browser=PASS |

## Raspberry Pi / ARM run — NOT_TESTED

No ARM/Raspberry Pi device was available while preparing v1.11.0. Because the Pi time budget is **NOT VERIFIED** on hardware, the unset fallback remains `shadow` (Compose files set `ENGINEERING_TOOLKIT: "auto"`, which resolves to `on` only when Chromium and >= 1.5 GB free RAM are detected and host is not low-RAM ARM). Owner action: run `npm run verify:device` on the Pi and paste the output table here.
