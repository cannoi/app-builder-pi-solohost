#!/bin/sh
set -eu
cd "$(dirname "$0")"
podman build -t sandbox-app-benchmark:2.0 .
exec podman run --rm -p "${PORT:-8080}:8080" sandbox-app-benchmark:2.0
