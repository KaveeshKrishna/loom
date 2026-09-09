#!/usr/bin/env bash
#
# Build the public, fully-fabricated demo of Loom.
#
# This is the real web/ Next.js app, built with NEXT_PUBLIC_DEMO_MODE=1,
# which (a) swaps a handful of server-auth-dependent files for client-only
# equivalents (see web/lib/demo/swap/), (b) drops app/api/ entirely (a
# static export can't include Route Handlers that use headers()/cookies(),
# which all of ours do via better-auth), and (c) sets `output: "export"` in
# next.config.ts. The result is a fully static SPA with NO backend — every
# `/api/*` call is answered from fabricated state held in the visitor's own
# browser (web/lib/demo/mockServer.ts) or by a Service Worker for real
# bundled placeholder media (web/public/demo-sw.js).
#
# Output: loom-demo/dist/  (served directly by Caddy — see README.md)
#
# Usage:
#   bash loom-demo/build.sh                 # normal build
#   bash loom-demo/build.sh --regen-photos  # also regenerate the placeholder
#                                            # photos before building (sharp;
#                                            # safe to skip, they're committed)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$HERE/../web"

if [ "${1:-}" = "--regen-photos" ]; then
  echo "-> Regenerating placeholder photos"
  ( cd "$WEB" && npx tsx lib/demo/generate-assets.ts )
fi

if [ ! -d "$WEB/node_modules" ]; then
  echo "-> Installing web/ dependencies (first run)"
  ( cd "$WEB" && npm ci --legacy-peer-deps )
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "-> Copying web/ into a scratch build directory"
rsync -a --exclude node_modules --exclude .next --exclude out --exclude '*.tsbuildinfo' "$WEB/" "$TMP/web/"
ln -s "$WEB/node_modules" "$TMP/web/node_modules"

cd "$TMP/web"

echo "-> Applying demo file swaps (production web/ is never touched)"
rm -rf app/api
rm -rf "app/(auth)/setup"
cp lib/demo/swap/page.tsx app/page.tsx
cp lib/demo/swap/login-page.tsx "app/(auth)/login/page.tsx"
cp lib/demo/swap/LoginForm.tsx "app/(auth)/login/LoginForm.tsx"
cp lib/demo/swap/main-layout.tsx "app/(main)/layout.tsx"
cp lib/demo/swap/settings-page.tsx "app/(main)/settings/page.tsx"
cp lib/demo/swap/root-layout.tsx app/layout.tsx

# app/(main)/files/[...path]/page.tsx is "use client" — a static export
# needs generateStaticParams() on every dynamic route, which can only be
# exported from a Server Component. Rename the real (unmodified) client
# component aside and drop in a thin server wrapper. See
# lib/demo/swap/files-catchall-page.tsx for why.
mv "app/(main)/files/[...path]/page.tsx" "app/(main)/files/[...path]/FilesPageInner.tsx"
cp lib/demo/swap/files-catchall-page.tsx "app/(main)/files/[...path]/page.tsx"

# The swap templates are only needed as sources for the copies above — with
# them still present, tsc/ESLint would also type-check them sitting in
# lib/demo/swap/, where files-catchall-page.tsx's relative import doesn't
# resolve (it's only valid once copied into app/(main)/files/[...path]/).
rm -rf lib/demo/swap

echo "-> Building static export (NEXT_PUBLIC_DEMO_MODE=1)"
NEXT_PUBLIC_DEMO_MODE=1 NEXT_TELEMETRY_DISABLED=1 npx next build

echo "-> Publishing to $HERE/dist"
rm -rf "$HERE/dist"
cp -r out "$HERE/dist"

echo "✔ Built to $HERE/dist"
echo "  Serve locally to check:  npx serve $HERE/dist   (or: cd $HERE/dist && python3 -m http.server 4173)"
