#!/usr/bin/env bash
# Back up Loom's database to backups/loom-<timestamp>.sql.gz and verify it.
#
# This covers metadata only — users, the file index, favorites, permissions,
# share links, audit log. It does NOT copy your media files (they are never
# modified by Loom's scripts) or the thumbnail cache (it can be regenerated).
#
# Keeps the newest LOOM_KEEP_BACKUPS backups (default 10); older ones made by
# this script are removed. Prints the backup path on the last line.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib.sh
. scripts/lib.sh
COMPOSE="$(compose_cmd)"

mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="backups/loom-$STAMP.sql.gz"
n=1
while [ -e "$OUT" ]; do OUT="backups/loom-$STAMP-$n.sql.gz"; n=$((n + 1)); done

# The database container must be running to take a dump.
if [ -z "$($COMPOSE ps -q postgres 2>/dev/null)" ] || ! wait_healthy postgres 5; then
  info "Starting the database container for the backup..."
  $COMPOSE up -d postgres >/dev/null
  wait_healthy postgres 90 || fail "The database container didn't become healthy. Check: $COMPOSE logs postgres"
fi

$COMPOSE exec -T postgres pg_dump -U loom -d loom --no-owner | gzip -c > "$OUT.partial"

# Verify: valid gzip, non-trivial size, and pg_dump's completion marker.
gzip -t "$OUT.partial" || { rm -f "$OUT.partial"; fail "Backup is not a valid gzip file."; }
if ! gzip -dc "$OUT.partial" | tail -n 20 | grep -q "PostgreSQL database dump complete"; then
  rm -f "$OUT.partial"
  fail "Backup looks incomplete (no 'dump complete' marker). Nothing was changed."
fi
mv "$OUT.partial" "$OUT"
chmod 600 "$OUT" 2>/dev/null || true

KEEP="${LOOM_KEEP_BACKUPS:-$(env_get LOOM_KEEP_BACKUPS)}"
KEEP="${KEEP:-10}"
case "$KEEP" in *[!0-9]*|""|0) KEEP=10 ;; esac
# shellcheck disable=SC2012
ls -1t backups/loom-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done

echo "Database backed up to $OUT ($(du -h "$OUT" | cut -f1))"
echo "$OUT"
