#!/usr/bin/env bash
# Stops and removes Loom's containers. Your media files (LOOM_MEDIA_PATH) are
# NEVER touched by this script under any circumstance. By default the
# PostgreSQL data volume (all indexed metadata, users, favorites, ACL rules)
# is also preserved, so re-running install.sh later restores your setup.
set -euo pipefail

cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

echo "This will stop and remove Loom's containers."
echo "Your media files are never touched by this script."
echo
read -r -p "Also permanently DELETE the database (all users, indexed metadata, favorites)? [y/N] " wipe_db

if [[ "$wipe_db" =~ ^[Yy]$ ]]; then
  read -r -p "Are you SURE? This cannot be undone. Type 'delete' to confirm: " confirm
  if [ "$confirm" = "delete" ]; then
    echo "Removing containers and database volume..."
    $COMPOSE down --volumes
    echo "Done. Database volume deleted."
    exit 0
  else
    echo "Confirmation did not match 'delete' — aborting. Nothing was changed."
    exit 1
  fi
fi

echo "Removing containers (database volume preserved)..."
$COMPOSE down
echo "Done. Run scripts/install.sh again to bring Loom back with your existing data."
