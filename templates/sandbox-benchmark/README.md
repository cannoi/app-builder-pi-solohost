# Sandbox App Benchmark v3.1

One-container baseline for qualifying a **Podman / Docker sandbox Preview** before testing generated web apps.

The page is self-contained: HTML, CSS and test JavaScript are inline. If Preview renders HTML but `/app.js` never runs, this build still tells you which layer is broken.

## What it tests

1. Node.js runtime (`/api/info`)
2. HTTP health (`/health`)
3. Browser JavaScript (inline compute + live clock)
4. Container filesystem write/read (`/api/write-test`)
5. Controlled CPU work (~250 ms, `/api/cpu-test`)
6. 5 parallel HTTP requests (`/api/parallel-test`)
7. Deep Internet path (`/api/internet-deep`): DNS → TCP/443 → TLS → HTTPS GET → redirects → HTTP, with per-target timing and proxy environment visibility
8. Web Test bar: load a public `http://` or `https://` URL through a restricted same-origin preview gateway

Baseline checks normally finish in **1–3 seconds**. The Deep Internet test can take up to **35 seconds** because it separately tests DNS, TCP/443, TLS, HTTPS GET, redirects and HTTP reachability.

## Run with Podman

```bash
podman build -t sandbox-app-benchmark .
podman run --rm -p 8080:8080 sandbox-app-benchmark
```

Open `http://localhost:8080`

Without building:

```bash
node server.js
```

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` | UI + inline tests |
| `/health` `/ready` `/live` | process health JSON |
| `/api/info` | runtime + writable dir |
| `/api/write-test` | write then read a file |
| `/api/cpu-test?ms=250` | short hash loop |
| `/api/parallel-test` | cheap concurrent probe |
| `/api/internet-test` | quick DNS + HTTPS baseline |
| `/api/internet-deep` | deep DNS/TCP/TLS/HTTP/HTTPS/redirect diagnostics |
| `/api/web-view?url=...` | restricted public Web Test gateway |
| `/api/self-test` | server-side FS + CPU, no browser JS |

## How to read the screen

| Time | Meaning |
| --- | --- |
| 0–3 s | Normal. Wait for **SANDBOX READY**. |
| 3–10 s | Container or Preview may still be starting. |
| >10 s still `Testing…` | HTML loaded, JS did not execute or fetch hung. |
| >30 s | Stop waiting. Sandbox/Preview problem. |

Layer row:

- **HTML** green as soon as the page is visible
- **JavaScript** green when the inline clock starts ticking
- **HTTP API** green after `/health`
- **Container** green after `/api/info`
- **Preview** green when the browser executed the page

If the page stays on the original `Starting tests…` text and the clock never ticks, Preview served HTML but did not run JavaScript.

## Interpretation

- **SANDBOX READY** = this common-app profile works here. It does not prove every app will work.
- **NOT READY** = inspect the failed check. Report it as a sandbox/runtime/preview issue, not an application build failure.

## Why v2 exists

v1 loaded `/app.js` from a separate file. A Preview that served HTML but failed to serve or execute JS stayed on `Testing…` forever and looked like a hung test. v2 keeps the six checks but does not depend on an external script to start diagnosing.

## Internet diagnosis

The benchmark separates network layers so a failure can be assigned before changing application code:

- `DNS_BLOCKED` — public names do not resolve.
- `TCP_443_BLOCKED` — DNS works but outbound TCP/443 is unreachable.
- `TLS_BLOCKED` — TCP works but TLS handshakes fail.
- `HTTPS_BLOCKED` — TLS works but HTTPS GET fails.
- `PARTIAL_INTERNET` — some public targets work and others fail.
- `REDIRECT_OR_FETCH_ISSUE` — direct HTTPS works but redirect-following requests fail.
- `INTERNET_HEALTHY` — the sandbox container has working outbound Internet for the tested public endpoints.

The Web Test bar is diagnostic only. It accepts public HTTP/HTTPS URLs, blocks private/local IP destinations, limits redirects and response size, and does not expose host Docker access.
