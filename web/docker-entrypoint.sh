#!/bin/sh
# Applies pending Prisma migrations before the server starts.
#
# If you are upgrading an existing Loom install that was set up before
# migrations existed (i.e. via `prisma db push`), see docs/UPGRADING.md —
# you must baseline the initial migration once before this will succeed.
set -e

echo "[entrypoint] Applying database migrations..."
node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy

echo "[entrypoint] Starting Loom..."
exec "$@"
