#!/usr/bin/env bash
# Run the browser tests in the Playwright Docker image (browsers included).
#   tests/run-e2e.sh [playwright args…]      e.g. --project=iphone e2e/smoke.spec.ts
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LOOM_TEST_DIR="${LOOM_TEST_DIR:-$HOME/.cache/loomtest}"
docker run --rm --network host --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e LOOM_TEST_DIR="$LOOM_TEST_DIR" -e LOOM_TEST_PORT -e LOOM_TEST_PG_PORT -e LOOM_TEST_LAN_PORT \
  -v "$here/..:/repo" -v "$LOOM_TEST_DIR:$LOOM_TEST_DIR" -w /repo/tests \
  mcr.microsoft.com/playwright:v1.48.0-jammy \
  npx playwright test "$@"
