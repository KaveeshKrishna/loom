#!/usr/bin/env bash
# Dumps the PostgreSQL database to backups/loom-<timestamp>.sql.
# This backs up metadata only (users, indexed file paths, favorites, ACL
# rules, audit log, etc.) — it does NOT back up your actual media files or
# the thumbnail/preview/video cache. Back those up separately if needed.
set -euo pipefail

cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

mkdir -p backups
OUT="backups/loom-$(date +%Y%m%d-%H%M%S).sql"

$COMPOSE exec -T postgres pg_dump -U loom -d loom > "$OUT"

echo "Database backed up to $OUT"
