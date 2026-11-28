#!/bin/sh
set -eu
export DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR" /app/workspace /app/projects
echo "[builder] App Builder — Pi SoloHost starting"
if [ "$#" -gt 0 ]; then exec "$@"; fi
exec node src/server.js
