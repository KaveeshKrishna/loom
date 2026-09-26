#!/usr/bin/env bash
# Update Loom to the latest version, safely.
#
#   ./scripts/update.sh             show what's new, back up, update, verify
#   ./scripts/update.sh --check     only report whether an update is available
#   ./scripts/update.sh --yes       don't ask for confirmation (for cron/automation)
#   ./scripts/update.sh --rebuild   rebuild and restart even if already up to date
#                                   (picks up security fixes in the base images)
#   ./scripts/update.sh --rollback  go back to the version before the last update
#
# What it guarantees:
#  - Your media folder is never touched. Only the code, the Docker images and
#    the database schema change.
#  - The database is backed up (and the backup verified) before anything
#    changes. If the backup fails, nothing happens.
#  - The new images are built while the old version keeps running, so a
#    failed build leaves Loom exactly as it was.
#  - Local edits to tracked files are never overwritten; the update stops and
#    tells you instead. Untracked and ignored files (.env, data/, backups/)
#    are never touched.
#
# Database migrations run automatically when loom-web starts (see
# web/docker-entrypoint.sh). They only ever add things, so an older version
# can still run on the updated database after a rollback.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib.sh
. scripts/lib.sh

MODE=update
ASSUME_YES="${ASSUME_YES:-0}"
REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --rollback) MODE=rollback ;;
    --rebuild) REBUILD=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "Unknown option: $arg (see --help)" ;;
  esac
done
export ASSUME_YES

STATE_DIR=.loom
LAST="$STATE_DIR/last-update"
IS_GIT=0
[ -d .git ] && command -v git >/dev/null 2>&1 && IS_GIT=1

version_at() { # version_at <commit> -> contents of VERSION there (or "unknown")
  git show "$1:VERSION" 2>/dev/null | head -n1 || echo "unknown"
}

short() { git rev-parse --short "$1"; }

# ─── checks shared by every mode ─────────────────────────────────────────────

preflight_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
  docker info >/dev/null 2>&1 || fail "Can't talk to Docker. Is it running, and are you allowed to use it? (try: sudo $0)"
  COMPOSE="$(compose_cmd)"
  [ -f .env ] || fail "No .env file here. Run ./scripts/install.sh first, or cd into your Loom folder."
  local secret
  secret="$(env_get BETTER_AUTH_SECRET)"
  if [ -z "$secret" ] || [ "$secret" = "generate_a_long_random_secret_here" ]; then
    fail "BETTER_AUTH_SECRET in .env is empty or the example value. Set it to the output of: openssl rand -base64 48"
  fi
  [ -n "$(env_get POSTGRES_PASSWORD)" ] || fail "POSTGRES_PASSWORD is not set in .env."
}

preflight_git() {
  [ "$IS_GIT" = "1" ] || return 0
  local dirty
  dirty="$(git status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ]; then
    warn "These files were changed locally:"
    git status --short --untracked-files=no | sed 's/^/      /'
    fail "Updating would conflict with your edits. Keep them with 'git stash' (restore later with 'git stash pop') or discard them with 'git checkout -- <file>', then run this again."
  fi
}

check_disk() {
  local avail_kb root
  avail_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
  root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -n "$root" ] && [ -d "$root" ]; then
    local r
    r="$(df -Pk "$root" | awk 'NR==2 {print $4}')"
    [ "$r" -lt "$avail_kb" ] && avail_kb="$r"
  fi
  if [ "${avail_kb:-0}" -lt 2097152 ]; then
    warn "Less than 2 GB of free disk space ($((avail_kb / 1024)) MB). Building the images may fail."
    warn "Old unused images can be removed with: docker image prune"
    confirm "Continue anyway?" || fail "Cancelled. Nothing was changed."
  fi
}

show_logs() {
  echo
  warn "Last lines of the loom-web log:"
  $COMPOSE logs --tail=60 loom-web 2>&1 | sed 's/^/      /' || true
}

# Build, restart and verify. Returns non-zero if Loom didn't come up healthy.
deploy() {
  bold "Building the images (the running version keeps serving meanwhile)..."
  if ! $COMPOSE build --pull; then
    return 10
  fi

  bold "Restarting Loom..."
  $COMPOSE up -d

  info "Waiting for loom-web. Database migrations run now; on a large library this can take a few minutes..."
  if ! wait_healthy loom-web 900; then
    return 20
  fi
  if ! wait_healthy loom-scanner 120; then
    warn "loom-scanner isn't running. Check: $COMPOSE logs --tail=100 loom-scanner"
    return 30
  fi
  local running
  running="$($COMPOSE exec -T loom-web wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
  [ -n "$running" ] && ok "Loom $running is running."
  return 0
}

# ─── --check ─────────────────────────────────────────────────────────────────

if [ "$MODE" = "check" ]; then
  [ "$IS_GIT" = "1" ] || fail "This isn't a git checkout, so updates can't be checked automatically."
  git fetch --quiet || fail "Couldn't reach the git remote."
  UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || fail "The current branch doesn't track a remote branch."
  BEHIND="$(git rev-list --count "HEAD..$UPSTREAM")"
  if [ "$BEHIND" = "0" ]; then
    ok "Up to date (version $(cat VERSION 2>/dev/null || echo unknown), $(short HEAD))."
    exit 0
  fi
  info "Update available: $(cat VERSION 2>/dev/null || echo unknown) → $(version_at "$UPSTREAM") ($BEHIND new commits)."
  info "Run ./scripts/update.sh to install it."
  exit 2
fi

# ─── --rollback ──────────────────────────────────────────────────────────────

if [ "$MODE" = "rollback" ]; then
  [ "$IS_GIT" = "1" ] || fail "Rollback needs a git checkout."
  [ -f "$LAST" ] || fail "No previous update recorded (looked for $LAST). Nothing to roll back to."
  preflight_docker
  preflight_git
  PREV="$(sed -n 's/^previous=//p' "$LAST")"
  BACKUP="$(sed -n 's/^backup=//p' "$LAST")"
  MIGRATIONS="$(sed -n 's/^migrations=//p' "$LAST")"
  git cat-file -e "$PREV^{commit}" 2>/dev/null || fail "The recorded previous version ($PREV) isn't in this repository."
  CURRENT="$(git rev-parse HEAD)"
  if [ "$CURRENT" = "$(git rev-parse "$PREV")" ]; then
    ok "Already at the previous version ($(short "$PREV")). Nothing to do."
    exit 0
  fi
  git merge-base --is-ancestor "$PREV" HEAD || fail "The current code isn't a newer version of $(short "$PREV"); roll back by hand (see docs/UPGRADING.md)."

  bold "Roll back Loom"
  info "Code:     $(cat VERSION 2>/dev/null || echo unknown) ($(short HEAD)) → $(version_at "$PREV") ($(short "$PREV"))"
  info "Media:    not touched."
  RESTORE=0
  if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
    info "Database: backed up before the update to $BACKUP"
    if [ "${MIGRATIONS:-0}" != "0" ]; then
      info "That update changed the database ($MIGRATIONS migration(s)). The older version still runs on the"
      info "updated database, so restoring it is only needed if the update itself failed while migrating."
    fi
    if [ "$ASSUME_YES" != "1" ] && confirm "Also restore the database from that backup? Changes since the update (new users, favorites, share links) would be lost."; then
      RESTORE=1
    fi
  fi
  confirm "Roll back now?" || fail "Cancelled. Nothing was changed."

  # The tree is clean (checked above), so this only moves tracked files back.
  # Untracked/ignored files such as .env, data/ and backups/ are untouched.
  git reset --hard --quiet "$PREV"
  ok "Code is back at $(short "$PREV")."
  echo "rolled_back_from=$CURRENT" >> "$LAST"

  if [ "$RESTORE" = "1" ]; then
    bold "Building the previous version's images..."
    $COMPOSE build || fail "Build failed. Your data is safe; fix the build error and run: $COMPOSE up -d --build"
    ASSUME_YES=1 ./scripts/restore-db.sh "$BACKUP"
  fi
  if deploy; then
    ok "Rolled back. Run ./scripts/update.sh again once a fixed version is available."
  else
    show_logs
    fail "The previous version didn't come up healthy either. Your media is untouched and the backups are in backups/. See docs/TROUBLESHOOTING.md."
  fi
  exit 0
fi

# ─── update ──────────────────────────────────────────────────────────────────

bold "Loom updater"
preflight_docker
preflight_git

FROM_VERSION="$(cat VERSION 2>/dev/null || echo unknown)"

if [ "$IS_GIT" = "1" ]; then
  info "Checking for updates..."
  git fetch --quiet || fail "Couldn't reach the git remote. Check your network connection."
  UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" ||
    fail "The current branch doesn't track a remote branch. Switch to main with: git checkout main"
  PREV="$(git rev-parse HEAD)"
  TARGET="$(git rev-parse "$UPSTREAM")"
  if [ "$PREV" = "$TARGET" ] && [ "$REBUILD" = "0" ]; then
    ok "Already up to date (version $FROM_VERSION, $(short HEAD))."
    info "To rebuild anyway (for base-image security fixes), run: $0 --rebuild"
    exit 0
  fi
  if ! git merge-base --is-ancestor HEAD "$TARGET"; then
    fail "Your checkout has commits that aren't on $UPSTREAM, so it can't be fast-forwarded. See docs/UPGRADING.md (\"Local changes\")."
  fi
  if [ -f "$LAST" ] && grep -q "^rolled_back_from=$TARGET\$" "$LAST"; then
    warn "You rolled back from this exact version before."
  fi

  TO_VERSION="$(version_at "$TARGET")"
  NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$PREV" "$TARGET" -- web/prisma/migrations | grep -c 'migration.sql$' || true)"
  if [ "$PREV" != "$TARGET" ]; then
    echo
    info "Version:  $FROM_VERSION → $TO_VERSION"
    info "Changes ($(git rev-list --count "$PREV..$TARGET") commits):"
    git log --no-merges --format='      • %s' "$PREV..$TARGET" | head -n 25
    [ "$NEW_MIGRATIONS" != "0" ] && info "Database: $NEW_MIGRATIONS new migration(s); applied automatically after the backup."
    info "Release notes: CHANGELOG.md, and docs/UPGRADING.md for anything to do by hand."
  fi
else
  warn "This isn't a git checkout, so the new code can't be downloaded automatically."
  info "Replace the files with the new release first (keep your .env), then run this again."
  PREV="" TARGET="" NEW_MIGRATIONS=0 TO_VERSION="$FROM_VERSION"
fi

echo
check_disk
confirm "Back up the database and update now?" || fail "Cancelled. Nothing was changed."

# 1. Backup. If it fails, stop before anything changes.
bold "Backing up the database..."
BACKUP="$(./scripts/backup-db.sh | tail -n1)" || fail "The backup failed, so nothing was changed. See the error above."
[ -f "$BACKUP" ] || fail "The backup failed, so nothing was changed."
ok "Backup verified: $BACKUP"

# 2. Record where we came from, for --rollback.
if [ "$IS_GIT" = "1" ]; then
  mkdir -p "$STATE_DIR"
  {
    echo "previous=$PREV"
    echo "target=$TARGET"
    echo "backup=$BACKUP"
    echo "migrations=$NEW_MIGRATIONS"
    echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$LAST"
fi

# 3. New code (fast-forward only: never merges, never discards anything).
if [ "$IS_GIT" = "1" ] && [ "$PREV" != "$TARGET" ]; then
  git merge --ff-only --quiet "$TARGET"
  ok "Code updated to $(short HEAD)."
fi

# 4. Build, restart, verify.
set +e
deploy
RESULT=$?
set -e

if [ "$RESULT" = "0" ]; then
  echo
  ok "Update complete ($FROM_VERSION → $(cat VERSION 2>/dev/null || echo "$TO_VERSION"))."
  info "Database backup from before the update: $BACKUP"
  [ "$IS_GIT" = "1" ] && info "If something's wrong, go back with: $0 --rollback"
  exit 0
fi

if [ "$RESULT" = "10" ]; then
  # Build failed: the old containers are still running untouched. Put the
  # code back so what's on disk matches what's running.
  if [ "$IS_GIT" = "1" ] && [ "$PREV" != "$TARGET" ]; then
    git reset --hard --quiet "$PREV"
  fi
  fail "Building the new images failed. Loom is still running the previous version and nothing else changed. Try again later, or report the error above."
fi

show_logs
echo
warn "The new version didn't come up healthy. Your media is untouched."
info "Backup from before the update: $BACKUP"
info "To go back to the previous version:  $0 --rollback"
info "More help: docs/TROUBLESHOOTING.md"
if [ "$IS_GIT" = "1" ] && [ "$ASSUME_YES" != "1" ] && confirm "Roll back now?"; then
  exec "$0" --rollback
fi
exit 1
