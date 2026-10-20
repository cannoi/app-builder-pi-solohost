#!/bin/sh
set -eu
echo "[entrypoint] node=$(node -v) port=${PORT:-8080} bind=${BIND:-0.0.0.0}"
echo "[entrypoint] cwd=$(pwd) user=$(id -u)"
# Preflight critical modules (fail with clear message)
node --input-type=module -e "
import('yaml').then(() => console.log('[preflight] yaml ok'))
  .catch((e) => { console.error('[preflight] yaml MISSING', e); process.exit(1); });
" || exit 1
node --input-type=module -e "
import('node:sqlite').then(() => console.log('[preflight] node:sqlite ok'))
  .catch((e) => { console.error('[preflight] node:sqlite MISSING', e); process.exit(1); });
" || exit 1
exec node --trace-uncaught src/boot.js
