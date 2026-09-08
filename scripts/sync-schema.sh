#!/usr/bin/env bash
# sync-schema.sh
#
# web/prisma/schema.prisma and scanner/prisma/schema.prisma must be
# byte-identical: the web app owns the schema and migrations, and the
# scanner's own copy is only there so its Docker image can `prisma generate`
# a matching client at build time (compose additionally bind-mounts web's
# copy over it at runtime as a belt-and-suspenders measure). If the two
# drift, the scanner can generate a client that disagrees with the database
# schema web actually migrated to — a class of bug this project already hit
# once.
#
# Usage:
#   scripts/sync-schema.sh          # check only (exit 1 if out of sync)
#   scripts/sync-schema.sh --fix    # copy web's schema over scanner's
set -euo pipefail

cd "$(dirname "$0")/.."

WEB_SCHEMA="web/prisma/schema.prisma"
SCANNER_SCHEMA="scanner/prisma/schema.prisma"

if [ "${1:-}" = "--fix" ]; then
  cp "$WEB_SCHEMA" "$SCANNER_SCHEMA"
  echo "Copied $WEB_SCHEMA -> $SCANNER_SCHEMA"
  exit 0
fi

if diff -q "$WEB_SCHEMA" "$SCANNER_SCHEMA" > /dev/null 2>&1; then
  echo "OK: schema.prisma is in sync between web/ and scanner/"
  exit 0
else
  echo "ERROR: web/prisma/schema.prisma and scanner/prisma/schema.prisma have diverged." >&2
  echo "Run: scripts/sync-schema.sh --fix" >&2
  echo >&2
  diff "$WEB_SCHEMA" "$SCANNER_SCHEMA" || true
  exit 1
fi
