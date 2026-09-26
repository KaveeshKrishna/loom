# shellcheck shell=bash
# Shared helpers for Loom's scripts. Sourced, not executed.

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✔ %s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
  else
    fail "Docker Compose is not installed (need 'docker compose' or 'docker-compose')."
  fi
}

# Read a KEY=value from .env without sourcing it (values may contain $ etc.)
env_get() {
  [ -f .env ] || return 0
  # A missing key is normal (most are optional): print nothing, succeed.
  { grep -E "^$1=" .env || true; } | tail -n1 | cut -d= -f2-
}

# Wait until a service reports healthy (or running, if it has no
# healthcheck). "unhealthy" isn't final — loom-web stays unhealthy while a
# long database migration runs — so keep waiting until the timeout, but give
# up early if the container stopped or keeps crashing.
wait_healthy() {
  local service="$1" timeout="${2:-180}" waited=0 id state restarts first_restarts=""
  while [ "$waited" -lt "$timeout" ]; do
    id="$($COMPOSE ps -q "$service" 2>/dev/null | head -n1)"
    if [ -n "$id" ]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      restarts="$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)"
      [ -z "$first_restarts" ] && first_restarts="$restarts"
      case "$state" in
        healthy|running) return 0 ;;
        exited|dead) return 1 ;;
      esac
      [ "$((restarts - first_restarts))" -ge 2 ] && return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

confirm() {
  # confirm "question" -> returns 0 for yes. Honors ASSUME_YES=1.
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  local answer
  read -r -p "  $1 [y/N] " answer || true
  [[ "$answer" =~ ^[Yy]$ ]]
}
