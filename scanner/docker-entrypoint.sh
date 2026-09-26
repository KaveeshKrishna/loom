#!/bin/sh
# Starts the scanner as the unprivileged "node" user (uid 1000).
#
# Loom versions before 2.0 ran the scanner as root, so an existing thumbnail
# cache can contain root-owned files the scanner can no longer replace. On
# start we hand those (and only those) to "node", then drop root for good.
# Only /cache is touched; /media is never chowned. As a safety net the fix is
# skipped if /cache looks like the media folder (a misconfiguration).
set -e

if [ "$(id -u)" = "0" ]; then
  looks_like_media=0
  if [ -d /media ] && [ "$(stat -c %d:%i /cache 2>/dev/null)" = "$(stat -c %d:%i /media 2>/dev/null)" ]; then
    looks_like_media=1
  fi
  if [ -e /cache/.LoomTrash ] || [ -e /cache/.tmp-upload ]; then
    looks_like_media=1
  fi
  media="${LOOM_MEDIA_PATH%/}"
  cache="${LOOM_CACHE_PATH%/}"
  if [ -n "$media" ] && [ -n "$cache" ]; then
    case "$cache/" in "$media"/*) looks_like_media=1 ;; esac
  fi

  if [ "$looks_like_media" = "1" ]; then
    echo "[entrypoint] warning: the cache folder looks like (or sits inside) the media folder."
    echo "[entrypoint] Not changing any file ownership. Point LOOM_CACHE_PATH at a separate folder."
  elif [ -d /cache ]; then
    # -xdev: stay on the cache filesystem. find doesn't follow symlinks and
    # chown -h changes a link itself, never what it points to.
    find /cache -xdev -user 0 -exec chown -h node:node {} + 2>/dev/null ||
      echo "[entrypoint] warning: could not change ownership of some cache files"
  fi
  exec su-exec node "$@"
fi

exec "$@"
