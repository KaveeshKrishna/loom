#!/usr/bin/env bash
# Render Loom's icons for the website, the Windows app and the Android app
# from the SVGs in brand/ (made by brand/mark.py). Needs Docker; nothing is
# installed on the host.
#
#   python3 brand/mark.py && bash brand/build.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
python3 brand/mark.py clients/android/app/src/main/res

# Rendering runs as root inside a throwaway container (apk needs it), then
# hands the files back to you.
docker run --rm -v "$root:/repo" -w /repo -e OWNER="$(id -u):$(id -g)" alpine:3.20 sh -euc '
  apk add --no-cache rsvg-convert imagemagick >/dev/null
  png() { rsvg-convert -w "$2" -h "$2" "brand/$1.svg" -o "$3"; }
  ico() { src=$1; out=$2; shift 2; tmp=$(mktemp -d); for s in "$@"; do png "$src" "$s" "$tmp/$s.png"; done
          magick $(for s in "$@"; do echo "$tmp/$s.png"; done) "$out"; rm -rf "$tmp"; }

  # Website: favicon, browser tab (SVG), home-screen icons
  cp brand/loom.svg web/app/icon.svg
  ico loom web/app/favicon.ico 16 32 48
  png loom-square 180 web/app/apple-icon.png
  mkdir -p web/public/icons
  png loom 192 web/public/icons/icon-192.png
  png loom 512 web/public/icons/icon-512.png
  png loom-maskable 512 web/public/icons/maskable-512.png

  # Windows app: window, taskbar, tray and installer
  d=clients/desktop/src-tauri/icons
  png loom 32 $d/32x32.png
  png loom 128 $d/128x128.png
  png loom 256 $d/128x128@2x.png
  png loom 512 $d/icon.png
  ico loom $d/icon.ico 16 20 24 32 40 48 64 256

  chown -R "$OWNER" web/app/icon.svg web/app/favicon.ico web/app/apple-icon.png web/public/icons $d
'
echo "Icons written."
