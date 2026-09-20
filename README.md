# SoloHost Browser

A lightweight web surface and local app hub for SoloHost. This is not a replacement for Chrome. It is a quiet place to search the web and open applications that SoloHost has registered.

Version 2 redesigns the interface as an open digital space. Apps float independently. There is no card grid.

## Roles

1. Lightweight browser interface (address, tabs, iframe viewport)
2. Local app hub fed by SoloHost App Manager

## Architecture

```
Browser UI  →  SoloHost Browser API  →  App Manager → App Registry
     │
     └────→  Local Web Gateway :8081  →  Internet (HTTP/HTTPS)
                 │
                 └── blocks private/local destinations (SSRF protection)

The embedded web viewport does not iframe arbitrary websites directly. External pages are loaded through the dedicated local Web Gateway because many websites intentionally block iframe embedding with `X-Frame-Options` or CSP `frame-ancestors`. This is the root cause of the previous "cannot browse Internet" behavior.
```

The browser never talks to Docker. It only calls:

- `GET /api/apps`
- `GET /api/status`
- `GET|POST /api/bookmarks`
- `GET|POST /api/history`
- `GET /apps/:id` (gateway)

Discovery sources, in order:

1. `SOLOHOST_APP_MANAGER_URL` if set — the App Manager service is the only component allowed to read Docker/container state (via `solohost.app=true` labels) and it exposes that as a plain HTTP API
2. `data/apps.json` registry file
3. Built-in demo apps when `SOLOHOST_DEMO_APPS` is not `0`

This container never mounts or reads `/var/run/docker.sock`, and never talks to the Docker Engine API directly — not even read-only. The Web Gateway is HTTP(S)-only and blocks loopback, private, link-local and other local-resolver destinations. Label-based discovery is entirely the App Manager's responsibility; this app only ever consumes its HTTP API.

Supported labels (interpreted by App Manager, not by this app):

```
solohost.app=true
solohost.app.id=calculator
solohost.app.name=Calculator
solohost.app.route=/apps/calculator
solohost.app.icon=calculator
```

Infrastructure containers stay invisible.

## Run

```bash
npm install
npm start
```

Open `http://127.0.0.1:8080`. The embedded Internet gateway is exposed only on `127.0.0.1:18081`.

```bash
docker compose up --build
```

## Pi Account

The `/api/auth/status` contract is ready. Authentication stays optional in V1. Wallet passphrases, private keys and seed phrases are never stored.

## Design

Space, typography, light, depth, iconography, subtle motion. No SaaS admin chrome. No card launcher.
