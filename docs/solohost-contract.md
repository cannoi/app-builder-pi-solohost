# SoloHost Knowledge Used by App Builder

Source: Pi Network's official SoloHost developer contract and Pi Desktop 0.6.3 update.

## Current package model

SoloHost publishing uses two files:

- `docker-compose.yml` — runtime stack
- `config_options.yml` — installer settings

The application itself lives in a pre-built public Docker image. SoloHost pulls that image and runs `docker compose up -d`; the published package does not build the image.

## UI service

The UI service should:

- use `pi.ui.primary: "true"`;
- publish exactly one UI port;
- bind the host side to `127.0.0.1:HOST:CONTAINER`;
- expose the real container serving port.

Readiness is important because Pi Desktop now uses readiness probing to reduce intermittent 502 errors.

## Security contract

Avoid:

- `privileged`
- `cap_add`
- `security_opt`
- host networking
- host namespaces
- `devices`
- unsafe bind mounts
- host-driver networks
- host Docker socket in the published app package

Use named volumes for persistent application data when needed.

## Configuration contract

Every `${VAR}` referenced by `docker-compose.yml` must be declared in `config_options.yml`. Supported installer field types include `text`, `password`, `number`, `select`, and `hidden`.

## Publishing validation

The authoritative hosted validator is:

`POST https://solohost-nohcqud24xwnsmna.staging.piappengine.com/api/apps/validate`

App Builder calls this validator during release when network access is available.

## Official references

- https://github.com/pi-node/solohost
- https://github.com/pi-node/solohost/blob/main/SOLOHOST.md
- https://minepi.com/blog/solohost-pi-desktop-0-6-3/

## Current official contract notes used by Builder (September 2026)

The official `pi-node/solohost` contract states that a SoloHost package contains `docker-compose.yml` and `config_options.yml`, points to a **pre-built public image**, and is installed by pulling the image and running Compose; it does not build the image. The UI service needs `pi.ui.primary: "true"` and one loopback-bound UI port. Blocked constructs include `privileged`, `cap_add`, `security_opt`, host networking/namespaces, devices, unsafe mounts, and host-driver networks.

The contract also identifies the hosted validation API as the authoritative pre-publish check. Builder calls that validator when network access is available and treats a failed validation as a release blocker.

Pi Network's September 9, 2026 SoloHost update confirms that Pi Desktop 0.6.3 added a readiness probe and a new SoloHost developer contract for building and troubleshooting apps.

Important distinction: the **Builder's own development/runtime container** may need host Docker access so it can build and test generated apps. That is different from the **generated SoloHost app package**. The generated package must not expose `/var/run/docker.sock` to the app container.
