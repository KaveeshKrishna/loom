#!/usr/bin/env bash
# LAN access for the Loom apps: HTTPS on your local network, so the desktop
# and mobile apps upload straight to this machine when they're at home,
# instead of out to the internet and back through your tunnel or proxy.
#
#   ./scripts/lan.sh enable [--host 192.168.1.20] [--port 8443]
#   ./scripts/lan.sh status
#   ./scripts/lan.sh disable
#
# enable:
#   1. creates a private certificate authority, once (it is never replaced),
#      in LOOM_LAN_PKI_PATH (default data/lan-pki): ca/root.key stays private
#      (only you and the loom-lan container can read it); public/root.crt is
#      what the apps trust for this address
#   2. writes LOOM_LAN_HOST, LOOM_LAN_PORT, LOOM_LAN_BIND and
#      COMPOSE_PROFILES=lan to .env
#   3. starts the loom-lan service and checks it answers over HTTPS
# Apps pick the address up by themselves (GET /api/client/info).
#
# Give this machine a fixed address in your router (a DHCP reservation), or
# run enable again whenever it changes. Never touches the media folder.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib.sh
. scripts/lib.sh

COMPOSE="$(compose_cmd)"
[ -f .env ] || fail "No .env found. Run ./scripts/install.sh first."

pki_path() {
  local p
  p="$(env_get LOOM_LAN_PKI_PATH)"
  echo "${p:-./data/lan-pki}"
}

detect_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }'
}

profiles_without_lan() {
  env_get COMPOSE_PROFILES | tr ',' '\n' | grep -v -x 'lan' | grep -v '^$' | paste -sd, - || true
}

check_https() {
  # check_https <host> <port> <ca file>
  curl -fsS --max-time 5 --cacert "$3" "https://$1:$2/api/health" >/dev/null 2>&1
}

cmd_enable() {
  local host="" port=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --host) host="${2:-}"; shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  command -v openssl >/dev/null 2>&1 || fail "openssl is required."
  command -v curl >/dev/null 2>&1 || fail "curl is required."

  host="${host:-$(env_get LOOM_LAN_HOST)}"
  host="${host:-$(detect_ip)}"
  [ -n "$host" ] || fail "Couldn't find this machine's LAN address. Pass it with --host 192.168.x.y"
  [[ "$host" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "--host must be an IPv4 address on your local network (got: $host)"
  port="${port:-$(env_get LOOM_LAN_PORT)}"
  port="${port:-8443}"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    fail "--port must be a port number"
  fi

  bold "LAN access for the Loom apps"
  info "Address: https://$host:$port"

  # The CA must never end up inside the media folder.
  local pki media
  pki="$(pki_path)"
  media="$(env_get LOOM_MEDIA_PATH)"
  if [ -n "$media" ]; then
    case "$(realpath -m "$pki")/" in
      "$(realpath -m "$media")"/*) fail "LOOM_LAN_PKI_PATH ($pki) is inside the media folder. Choose another place." ;;
    esac
  fi

  if [ -f "$pki/ca/root.key" ] && [ -f "$pki/public/root.crt" ]; then
    ok "Certificate authority already exists ($pki) — keeping it"
  else
    if [ -e "$pki/ca/root.key" ] || [ -e "$pki/public/root.crt" ]; then
      fail "$pki is incomplete (ca/root.key or public/root.crt is missing). Move it away and run this again."
    fi
    mkdir -p "$pki/ca" "$pki/public"
    chmod 700 "$pki/ca"
    (
      umask 077
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
        -subj "/CN=Loom LAN CA" \
        -addext "basicConstraints=critical,CA:TRUE,pathlen:1" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" \
        -keyout "$pki/ca/root.key" -out "$pki/public/root.crt" 2>/dev/null
    ) || fail "openssl couldn't create the certificate authority."
    chmod 600 "$pki/ca/root.key"
    chmod 644 "$pki/public/root.crt"
    ok "Created a certificate authority in $pki (valid 10 years; back up this folder)"
  fi

  env_set LOOM_LAN_HOST "$host"
  env_set LOOM_LAN_PORT "$port"
  env_set LOOM_LAN_BIND "$host"
  local others
  others="$(profiles_without_lan)"
  env_set COMPOSE_PROFILES "${others:+$others,}lan"
  ok "Saved the LAN settings in .env"

  $COMPOSE up -d >/dev/null
  # loom-web reads the new settings when it is recreated; up -d does that.
  info "Waiting for the LAN address to answer…"
  for _ in $(seq 1 30); do
    if check_https "$host" "$port" "$pki/public/root.crt"; then
      ok "https://$host:$port answers, with a certificate from Loom's own authority"
      echo
      info "The apps switch to this address by themselves when they're on this network."
      info "Give this machine a fixed address in your router (DHCP reservation)."
      return 0
    fi
    sleep 2
  done
  warn "https://$host:$port didn't answer yet. Check: $COMPOSE logs loom-lan"
  return 1
}

cmd_status() {
  local host port pki state
  host="$(env_get LOOM_LAN_HOST)"
  port="$(env_get LOOM_LAN_PORT)"
  port="${port:-8443}"
  pki="$(pki_path)"
  if ! grep -qx lan <<<"$(env_get COMPOSE_PROFILES | tr ',' '\n')"; then
    info "LAN access is off. Turn it on with: $0 enable"
    return 0
  fi
  info "Address:  https://$host:$port"
  state="$(docker inspect -f '{{.State.Status}}' "$($COMPOSE ps -q loom-lan 2>/dev/null | head -n1)" 2>/dev/null || echo "not running")"
  info "Service:  $state"
  if [ -f "$pki/public/root.crt" ]; then
    info "CA:       $(openssl x509 -in "$pki/public/root.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
    if check_https "$host" "$port" "$pki/public/root.crt"; then ok "Answers over HTTPS"; else warn "Not answering over HTTPS"; fi
  else
    warn "No certificate authority in $pki — run: $0 enable"
  fi
}

cmd_disable() {
  env_set COMPOSE_PROFILES "$(profiles_without_lan)"
  $COMPOSE rm -sf loom-lan >/dev/null 2>&1 || true
  $COMPOSE up -d >/dev/null
  ok "LAN access is off. The apps go through your normal address again."
  info "The certificate authority in $(pki_path) is kept, so turning it back on needs no re-pairing."
}

case "${1:-}" in
  enable) shift; cmd_enable "$@" ;;
  status) cmd_status ;;
  disable) cmd_disable ;;
  *) echo "Usage: $0 enable [--host IP] [--port PORT] | status | disable" >&2; exit 2 ;;
esac
