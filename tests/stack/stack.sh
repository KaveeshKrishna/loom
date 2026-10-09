#!/usr/bin/env bash
# Start, stop or reset the disposable Loom used by the integration tests.
#
#   tests/stack/stack.sh up      build from this checkout and start (waits until healthy)
#   tests/stack/stack.sh down    stop it and delete its database, media and cache
#   tests/stack/stack.sh reset   down + up (a fresh, empty Loom)
#   tests/stack/stack.sh logs    follow loom-web's logs
#
# Media, cache and the LAN test CA live in $LOOM_TEST_DIR (default
# ~/.cache/loomtest). Ports: $LOOM_TEST_PORT (18085) and $LOOM_TEST_LAN_PORT
# (18443). It never touches a real installation: the compose project is
# "loomtest", nothing reads the repo's .env, and "down" only deletes a folder
# that "up" created (it carries a .loomtest marker).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LOOM_TEST_DIR="${LOOM_TEST_DIR:-$HOME/.cache/loomtest}"
export LOOM_TEST_PORT="${LOOM_TEST_PORT:-18085}"
export LOOM_TEST_LAN_PORT="${LOOM_TEST_LAN_PORT:-18443}"
MARKER="$LOOM_TEST_DIR/.loomtest"

compose() {
  docker compose -p loomtest -f "$here/compose.yml" "$@"
}

up() {
  if [ -d "$LOOM_TEST_DIR" ] && [ -n "$(ls -A "$LOOM_TEST_DIR" 2>/dev/null)" ] && [ ! -f "$MARKER" ]; then
    echo "Refusing to use $LOOM_TEST_DIR: it isn't empty and wasn't created by this script." >&2
    exit 1
  fi
  mkdir -p "$LOOM_TEST_DIR/media" "$LOOM_TEST_DIR/cache" "$LOOM_TEST_DIR/lan-pki/ca" "$LOOM_TEST_DIR/lan-pki/public"
  touch "$MARKER"
  # A throwaway LAN certificate authority, like scripts/lan.sh makes.
  if [ ! -f "$LOOM_TEST_DIR/lan-pki/ca/root.key" ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
      -subj "/CN=Loom LAN test CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:1" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout "$LOOM_TEST_DIR/lan-pki/ca/root.key" -out "$LOOM_TEST_DIR/lan-pki/public/root.crt" 2>/dev/null
    chmod 600 "$LOOM_TEST_DIR/lan-pki/ca/root.key"
  fi
  compose up -d --build --wait
  echo "Loom test stack is up: http://localhost:$LOOM_TEST_PORT (LAN: https://127.0.0.1:$LOOM_TEST_LAN_PORT, data in $LOOM_TEST_DIR)"
}

down() {
  compose down -v --remove-orphans
  [ -d "$LOOM_TEST_DIR" ] || return 0
  if [ ! -f "$MARKER" ]; then
    echo "Not deleting $LOOM_TEST_DIR: it has no .loomtest marker." >&2
    return 0
  fi
  # The containers write as uid 1000; if that isn't us, clean up from a container.
  rm -rf "$LOOM_TEST_DIR" 2>/dev/null ||
    docker run --rm -v "$LOOM_TEST_DIR:/d" alpine sh -c 'rm -rf /d/* /d/.[!.]* 2>/dev/null; true'
  rm -rf "$LOOM_TEST_DIR" 2>/dev/null || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset) down; up ;;
  logs) compose logs -f loom-web ;;
  *) echo "usage: $0 up|down|reset|logs" >&2; exit 2 ;;
esac
