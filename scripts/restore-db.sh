#!/usr/bin/env bash
# Restore Loom's database from a backup made by backup-db.sh.
#
#   ./scripts/restore-db.sh backups/loom-20260101-120000.sql.gz
#
# This replaces the database's current contents (users, index, favorites,
# permissions...) with the backup. Your media files are not touched. A fresh
# backup of the current state is taken first, so a restore can be undone.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib.sh
. scripts/lib.sh
COMPOSE="$(compose_cmd)"

FILE="${1:-}"
{ [ -n "$FILE" ] && [ -f "$FILE" ]; } || fail "Usage: $0 backups/loom-<timestamp>.sql.gz"
gzip -t "$FILE" 2>/dev/null || fail "$FILE is not a valid .sql.gz backup."
gzip -dc "$FILE" | tail -n 20 | grep -q "PostgreSQL database dump complete" || fail "$FILE looks incomplete."

bold "Restore database from $FILE"
warn "This replaces everything in Loom's database with the backup."
info "Your media files are NOT touched. The current database is backed up first."
if [ "${ASSUME_YES:-0}" != "1" ]; then
  read -r -p "  Type 'restore' to continue: " answer || true
  [ "$answer" = "restore" ] || fail "Cancelled. Nothing was changed."
fi

info "Backing up the current database first..."
./scripts/backup-db.sh | tail -n1 > /dev/null

info "Stopping loom-web and loom-scanner..."
$COMPOSE stop loom-web loom-scanner >/dev/null 2>&1 || true

info "Restoring..."
$COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 -q -U loom -d loom -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
gzip -dc "$FILE" | $COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 -q -U loom -d loom >/dev/null

info "Starting Loom..."
$COMPOSE up -d loom-web loom-scanner >/dev/null
if wait_healthy loom-web 180; then
  ok "Restored and running."
else
  warn "Loom didn't report healthy yet. Check: $COMPOSE logs --tail=100 loom-web"
  exit 1
fi
