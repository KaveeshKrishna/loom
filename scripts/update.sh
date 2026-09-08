#!/usr/bin/env bash
# Pulls the latest source (if this is a git checkout), rebuilds the images,
# and restarts. Database migrations are applied automatically by loom-web's
# entrypoint on startup — see web/docker-entrypoint.sh.
#
# If you are updating an install that predates migrations (originally set up
# with `prisma db push`), read docs/UPGRADING.md FIRST — you need to baseline
# the initial migration once, or `migrate deploy` will fail trying to create
# tables that already exist.
set -euo pipefail

cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

if [ -d .git ]; then
  echo "Pulling latest changes..."
  git pull --ff-only
else
  echo "Not a git checkout — skipping git pull. Update the source yourself first."
fi

echo "Backing up the database before migrating..."
"$(dirname "$0")/backup-db.sh"

echo "Building images..."
$COMPOSE build

echo "Restarting..."
$COMPOSE up -d

echo "Done. Tail logs with: $COMPOSE logs -f loom-web"
