#!/usr/bin/env bash
# Loom installer
#
# Idempotent and safe to re-run: it never overwrites an existing .env, and
# every step can be repeated without harm. Run from the repo root:
#
#   ./scripts/install.sh
#
# Non-interactive (CI / scripted installs) — set env vars up front and pass
# --non-interactive, e.g.:
#
#   LOOM_MEDIA_PATH=/mnt/media LOOM_CACHE_PATH=/mnt/cache \
#     ./scripts/install.sh --non-interactive
set -euo pipefail

cd "$(dirname "$0")/.."

NON_INTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    -h|--help)
      echo "Usage: $0 [--non-interactive]"
      exit 0
      ;;
  esac
done

# shellcheck source=lib.sh
. scripts/lib.sh

bold "Loom installer"
echo

# ── 1. Preflight ─────────────────────────────────────────────────────────────
bold "1/6  Checking prerequisites"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/"

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
  warn "Using legacy docker-compose. Docker Compose v2 (docker compose) is recommended."
else
  fail "Docker Compose is not installed (need 'docker compose' or 'docker-compose')."
fi
docker info >/dev/null 2>&1 || fail "Docker is installed but not reachable. Is the daemon running, and is your user allowed to use it? (try: sudo $0)"
info "Docker + Compose found ($COMPOSE)"

command -v openssl >/dev/null 2>&1 || fail "openssl is required to generate secrets."

echo

# ── 2. Configuration ─────────────────────────────────────────────────────────
bold "2/6  Configuration"

prompt() {
  # prompt <var_name> <question> <default>
  local var="$1" question="$2" default="$3" current answer
  current="${!var:-}"
  if [ -n "$current" ]; then
    return # already set via environment
  fi
  if [ "$NON_INTERACTIVE" = "1" ]; then
    printf -v "$var" '%s' "$default"
    return
  fi
  read -r -p "  $question [$default]: " answer || true
  printf -v "$var" '%s' "${answer:-$default}"
}

# With an existing .env, use its settings instead of asking.
if [ -f .env ]; then
  for v in LOOM_MEDIA_PATH LOOM_CACHE_PATH LOOM_BIND LOOM_PORT BETTER_AUTH_URL; do
    val="$(env_get "$v")"
    if [ -n "$val" ]; then printf -v "$v" '%s' "$val"; fi
  done
  info "Using the settings in your existing .env."
fi

prompt LOOM_MEDIA_PATH "Path to your media/files directory" "./data/media"
prompt LOOM_CACHE_PATH "Path for thumbnail/preview/video cache" "./data/cache"
prompt LOOM_BIND "Bind address (127.0.0.1 = local only, behind a reverse proxy)" "127.0.0.1"
prompt LOOM_PORT "Port to expose Loom on" "8085"
prompt BETTER_AUTH_URL "Public URL you'll access Loom at (e.g. https://loom.example.com)" "http://localhost:${LOOM_PORT}"

# Resolve a path the way it'll be used (relative paths are relative to the
# repo root, where compose.yml lives) without requiring it to exist.
abspath() {
  case "$1" in
    /*) realpath -m -- "$1" ;;
    *) realpath -m -- "$PWD/$1" ;;
  esac
}
MEDIA_ABS="$(abspath "$LOOM_MEDIA_PATH")"
CACHE_ABS="$(abspath "$LOOM_CACHE_PATH")"
case "$CACHE_ABS/" in
  "$MEDIA_ABS"/*) fail "The cache path ($CACHE_ABS) must not be the media folder or inside it. Loom writes and deletes cache files freely; keep them apart." ;;
esac
case "$MEDIA_ABS/" in
  "$CACHE_ABS"/*) fail "The media path ($MEDIA_ABS) must not be inside the cache folder." ;;
esac

# A typo in the media path would silently give Loom an empty folder.
if [ ! -d "$LOOM_MEDIA_PATH" ]; then
  if [ "$LOOM_MEDIA_PATH" = "./data/media" ]; then
    : # the default; created below
  elif [ "$NON_INTERACTIVE" = "1" ]; then
    fail "Media path $LOOM_MEDIA_PATH doesn't exist. Create it first (or fix the path)."
  else
    warn "Media path $LOOM_MEDIA_PATH doesn't exist."
    confirm "Create it as a new, empty folder?" || fail "Cancelled. Check the path and run the installer again."
  fi
fi

info "Media path:  $LOOM_MEDIA_PATH"
info "Cache path:  $LOOM_CACHE_PATH"
info "Bind:        $LOOM_BIND:$LOOM_PORT"
info "Public URL:  $BETTER_AUTH_URL"
echo

# ── 3. .env ───────────────────────────────────────────────────────────────────
bold "3/6  Writing .env"

if [ -f .env ]; then
  info ".env already exists — leaving it untouched."
  existing_secret="$(env_get BETTER_AUTH_SECRET)"
  existing_pg="$(env_get POSTGRES_PASSWORD)"
  if [ -z "$existing_secret" ] || [ "$existing_secret" = "generate_a_long_random_secret_here" ]; then
    fail "BETTER_AUTH_SECRET in your existing .env is empty or the example value. Set it to the output of 'openssl rand -base64 48' and run this again."
  fi
  if [ -z "$existing_pg" ] || [ "$existing_pg" = "change_this_strong_password" ]; then
    fail "POSTGRES_PASSWORD in your existing .env is empty or the example value. Set it to the output of 'openssl rand -hex 24' and run this again (before the database is first created)."
  fi
else
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  BETTER_AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

  cp .env.example .env
  # Use a delimiter unlikely to appear in generated values or paths.
  sed -i.bak \
    -e "s#^LOOM_MEDIA_PATH=.*#LOOM_MEDIA_PATH=${LOOM_MEDIA_PATH}#" \
    -e "s#^LOOM_CACHE_PATH=.*#LOOM_CACHE_PATH=${LOOM_CACHE_PATH}#" \
    -e "s#^LOOM_BIND=.*#LOOM_BIND=${LOOM_BIND}#" \
    -e "s#^LOOM_PORT=.*#LOOM_PORT=${LOOM_PORT}#" \
    -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${POSTGRES_PASSWORD}#" \
    -e "s#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}#" \
    -e "s#^BETTER_AUTH_URL=.*#BETTER_AUTH_URL=${BETTER_AUTH_URL}#" \
    -e "s#^TRUSTED_ORIGINS=.*#TRUSTED_ORIGINS=${BETTER_AUTH_URL}#" \
    .env
  rm -f .env.bak
  info "Generated .env with random POSTGRES_PASSWORD and BETTER_AUTH_SECRET."
fi
echo

# ── 4. Storage directories ───────────────────────────────────────────────────
bold "4/6  Preparing storage directories"

NEW_MEDIA=0
[ -d "$LOOM_MEDIA_PATH" ] || NEW_MEDIA=1
mkdir -p "$LOOM_MEDIA_PATH" "$LOOM_CACHE_PATH"
# The app containers run as uid:gid 1000:1000 (the "node" user).
# The cache is Loom's own, so it's safe to hand it to that user. The media
# folder holds your files: it's never chowned, except a folder this installer
# just created empty.
chown -R 1000:1000 "$LOOM_CACHE_PATH" 2>/dev/null || \
  warn "Could not chown $LOOM_CACHE_PATH to uid 1000 (may need sudo). If thumbnails fail, run: sudo chown -R 1000:1000 '$LOOM_CACHE_PATH'"
if [ "$NEW_MEDIA" = "1" ]; then
  chown 1000:1000 "$LOOM_MEDIA_PATH" 2>/dev/null || true
elif [ "$(stat -c %u "$LOOM_MEDIA_PATH" 2>/dev/null)" != "1000" ]; then
  warn "The media folder isn't owned by uid 1000. Loom can show what uid 1000 can read, but uploads,"
  warn "renames and edits need write access for it. See docs/INSTALLATION.md (\"Permissions\")."
fi
info "Media:  $(cd "$LOOM_MEDIA_PATH" && pwd)"
info "Cache:  $(cd "$LOOM_CACHE_PATH" && pwd)"
echo

# ── 5. Build & start ─────────────────────────────────────────────────────────
bold "5/6  Building and starting containers"

$COMPOSE build
$COMPOSE up -d
echo

# ── 6. Wait for readiness ────────────────────────────────────────────────────
bold "6/6  Waiting for Loom to become ready"

READY=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${LOOM_PORT}/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" != "1" ]; then
  warn "Loom did not report healthy within 3 minutes."
  warn "Check logs with: $COMPOSE logs -f loom-web"
  exit 1
fi

echo
bold "Loom is running!"
info "Open http://${LOOM_BIND}:${LOOM_PORT} to create your owner account."
if [ "$LOOM_BIND" = "127.0.0.1" ]; then
  info "(Bound to localhost only — set up a reverse proxy to reach it remotely: see docs/REVERSE-PROXY.md)"
fi
echo
info "Useful commands:"
info "  $COMPOSE ps"
info "  $COMPOSE logs -f loom-web"
info "  $COMPOSE logs -f loom-scanner"
info "  ./scripts/update.sh        # update safely (backs up, shows changes, verifies)"
info "  ./scripts/update.sh --check  # is there a new version?"
info "  ./scripts/backup-db.sh     # back up the database"
echo
info "Your files stay where they are: Loom never moves or deletes anything in"
info "the media folder except when you do it from the app (and deleted items go"
info "to Trash first). Back up that folder like any other important data."
