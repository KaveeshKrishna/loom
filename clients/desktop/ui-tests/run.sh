#!/usr/bin/env bash
# Build the app's screens with the mock backend and screenshot them (ui-tests/out/).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
uid="$(id -u):$(id -g)"
docker run --rm --user "$uid" -e HOME=/tmp -v "$here:/w" -w /w node:22-alpine sh -c 'npx vite build >/dev/null'
docker rm -f loom-desktop-preview >/dev/null 2>&1 || true
docker run -d --rm --name loom-desktop-preview --network host --user "$uid" -e HOME=/tmp -v "$here:/w" -w /w node:22-alpine \
  npx vite preview --port 1420 --host 127.0.0.1 --strictPort >/dev/null
trap 'docker rm -f loom-desktop-preview >/dev/null 2>&1 || true' EXIT
for _ in $(seq 30); do curl -fs http://127.0.0.1:1420 >/dev/null && break; sleep 1; done
docker run --rm --network host --ipc=host --user "$uid" -e HOME=/tmp -v "$repo:/repo" -w /repo/clients/desktop \
  mcr.microsoft.com/playwright:v1.48.0-jammy node ui-tests/screens.mjs
