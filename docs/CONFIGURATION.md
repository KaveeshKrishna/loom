# Configuration

All configuration is environment variables in `.env` at the repo root. Docker Compose loads it into each service (`env_file: .env`). `.env.example` documents the defaults, and the installer generates `.env` from it. After changing `.env`, apply it with `docker compose up -d`.

## Storage paths

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `LOOM_MEDIA_PATH` | `./data/media` | Yes, point it at your real files | Host folder mounted at `/media` in both containers. This is your file library. Loom works on it in place and keeps its own working files only in the hidden `.LoomTrash/` and `.tmp-upload/` subfolders. |
| `LOOM_CACHE_PATH` | `./data/cache` | Yes, pick a path with free space | Host folder mounted at `/cache`. Holds generated thumbnails, previews, video posters and converted video segments. Entirely derived and safe to delete; Loom regenerates it. **Must not be the media folder or inside it**: the installer refuses that, and the scanner won't change any file ownership if it detects it. |

Both folders must be accessible to uid 1000. See [Installation → File permissions](INSTALLATION.md#file-permissions).

## Network

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `LOOM_BIND` | `127.0.0.1` | No | Host address the web app's port is published on. Keep `127.0.0.1` and reach Loom through a reverse proxy or tunnel (see [REVERSE-PROXY.md](REVERSE-PROXY.md)). Use `0.0.0.0` only if you understand the exposure. |
| `LOOM_PORT` | `8085` | No | Host port for the web app (the container listens on 3000). |

## Database

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `POSTGRES_PASSWORD` | none | **Yes** | Password for the `loom` PostgreSQL user. The installer generates a random one. If you set it yourself, make it long and random. |
| `DATABASE_URL` | built in `compose.yml` | No | Constructed automatically from `POSTGRES_PASSWORD`. Only set it yourself when running outside Docker Compose, e.g. against an external PostgreSQL. |

## Authentication and share links

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | none | **Yes** | Signs login sessions and protects share links. The installer generates a random 48-byte value. loom-web **refuses to start** if it's missing or still the example value, and logs a warning if it's shorter than 32 characters. Changing it signs everyone out. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | **Yes in production** | The public URL Loom is served at, e.g. `https://loom.example.com`. Used to build auth callback URLs and the share links you hand out (`https://loom.example.com/s/…`), so set it to the address people outside your network will use. |
| `TRUSTED_ORIGINS` | empty | Recommended | Comma-separated list of origins allowed to make logged-in requests, e.g. `https://loom.example.com,http://localhost:8085`. List every hostname and port you'll actually use. |

Related behavior that isn't configurable:

- **Public sign-up is always disabled.** The first account is created on the setup page; after that the Owner adds users in Settings → Users.
- **Sign-in is rate-limited** to 10 attempts per minute per IP address (password changes to 5 per minute). Pass `X-Forwarded-For` from your proxy so this applies per visitor.
- **Sessions** last 30 days and are refreshed once a day while in use. Changing a user's password signs them out everywhere, including their apps.
- **Apps** (see [APPS.md](APPS.md)) sign in with a device token instead of a password: paired by approving the request in Loom, or with a one-time code from the Devices page. Only a hash of each token is stored. Removing a device in Devices signs it out at once. Device tokens can't do Owner administration, manage devices or create share links.
- **Share links** are off until the Owner enables them in Settings → Sharing. Link tokens are stored encrypted with a key derived from `BETTER_AUTH_SECRET`; changing the secret doesn't break existing links, but they can no longer be copied again from the UI.

## Uploads and background work

All optional, with sensible defaults. Leave them unset unless you have a reason.

| Variable | Default | Limits | Purpose |
|---|---|---|---|
| `LOOM_UPLOAD_CHUNK_MB` | `32` | 1 to 95 | Size of each upload chunk from the browser (the apps choose their own, within 1 to 95 MB). Must be below your reverse proxy's request size limit (Cloudflare's is 100 MB; nginx's `client_max_body_size` must be larger than this). |
| `LOOM_MAX_UPLOAD_GB` | no limit | | Largest single file that can be uploaded. Independently, an upload is always refused if it would leave less than 256 MB free on the drive. |
| `LOOM_UPLOAD_RESUME_DAYS` | `7` | 1 to 30 | How long an app's unfinished upload stays resumable without progress (a browser's: 24 hours). |
| `LOOM_UPLOAD_PARALLEL_CHUNKS` | `4` | 1 to 16 | Chunks of one file an app may send at the same time. |
| `LOOM_UPLOAD_PARALLEL_PER_USER` | `8` | 1 to 64 | Chunks one user's apps may send at the same time, across files. |
| `LOOM_UPLOAD_MAX_INFLIGHT` | `16` | 1 to 128 | Chunks being written at once on the whole server. |
| `LOOM_UPLOAD_WINDOW_MB` | `512` | 64 to 16384 | How far ahead of the first missing part an app's chunk may land. Drives without sparse files (exFAT, common on external disks) fill any gap with zeros on the spot, so this keeps that to a bounded amount. |
| `LOOM_WORKER_CONCURRENCY` | `2` | 1 to 8 | How many files the scanner processes in parallel (thumbnails, previews, video posters, metadata). Raise it on a machine with more cores; use `1` on a Raspberry Pi. |
| `LOOM_SHARP_THREADS` | `2` | 1 to 4 | Threads the image library (sharp) uses per job. |
| `LOOM_MAX_TRANSCODES` | `2` | at least 1 | How many videos can be converted for streaming at the same time. Each uses roughly one CPU core. |
| `LOOM_AUDIT_RETENTION_DAYS` | `180` | at least 1 | How long audit log entries are kept. |

## LAN access for the apps

Optional: HTTPS on your local network so the [apps](APPS.md) upload straight to this machine at home. `./scripts/lan.sh enable` sets all of these for you.

| Variable | Default | Purpose |
|---|---|---|
| `COMPOSE_PROFILES` | empty | Contains `lan` while LAN access is on, which starts the `loom-lan` service. |
| `LOOM_LAN_HOST` | none | This machine's address on your network, e.g. `192.168.1.20`. The certificate is issued for it. |
| `LOOM_LAN_PORT` | `8443` | Port of the LAN address. |
| `LOOM_LAN_BIND` | `127.0.0.1` | Host address the port is published on; `lan.sh` sets it to `LOOM_LAN_HOST` so it's only on the LAN interface (Docker's published ports bypass host firewalls, so don't use `0.0.0.0`). |
| `LOOM_LAN_URL` | from host and port | Override the address given to the apps, if it differs from `https://LOOM_LAN_HOST:LOOM_LAN_PORT`. |
| `LOOM_LAN_PKI_PATH` | `./data/lan-pki` | The private certificate authority: `ca/root.key` (only readable by you and the loom-lan container) and `public/root.crt`. Must not be inside the media folder. Back it up; if it's lost, `lan.sh enable` makes a new one and the apps re-trust it automatically. |

What the LAN address does and doesn't do:

- It only lets in requests carrying an app's device token, plus the two endpoints apps use to find it. There's no sign-in page and no browser session on it.
- Address headers sent by clients on your network are ignored; the proxy sets them.
- loom-web only ever sees the authority's public certificate (`/api/client/info` hands it to signed-in apps), never its key.

## Scripts

These are read by the scripts in `scripts/`, not by the containers.

| Variable | Default | Purpose |
|---|---|---|
| `LOOM_KEEP_BACKUPS` | `10` | How many database backups `backup-db.sh` keeps in `backups/`; older ones are deleted. Set it in `.env`, or for one run: `LOOM_KEEP_BACKUPS=30 ./scripts/backup-db.sh`. |
| `ASSUME_YES` | unset | Set to `1` to answer yes to every question, the same as `update.sh --yes`. Use carefully: `restore-db.sh` then restores without asking. |
| `LOOM_NEW_PASSWORD` | unset | For `reset-password.mjs` only: the new password, so the reset can run without a prompt. Normally you leave it unset and type the password when asked. |

## Next.js

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Standard Node environment flag. Leave it as `production`. |
| `NEXT_TELEMETRY_DISABLED` | `1` | Disables Next.js's anonymous telemetry. |

## Advanced: in-container path overrides

These are read inside the containers and exist for anyone running Loom outside Docker Compose. Leave them unset in a normal setup.

| Variable | Default | Read by | Purpose |
|---|---|---|---|
| `CACHE_ROOT` | `/cache` | loom-web and loom-scanner | In-container path of the cache. |
| `MEDIA_ROOT` | `/media` | loom-scanner only | In-container path of the media folder for the scanner. loom-web always uses `/media` (it's hardcoded in `web/lib/path-security.ts`), so if you change this, the web app must still see the media folder at `/media`. |

The public demo build uses one more variable, `NEXT_PUBLIC_DEMO_MODE=1`, set only by `loom-demo/build.sh`. Never set it for a real install.
