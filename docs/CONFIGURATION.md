# Configuration Reference

All configuration is via environment variables in `.env` at the repo root, loaded by Docker Compose (`env_file: .env` on each service). `.env.example` documents defaults; the installer generates `.env` from it.

## Storage paths

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `LOOM_MEDIA_PATH` | `./data/media` | Yes (set to your real files) | Host path bind-mounted to `/media` in both containers. This is your actual file library — Loom reads and organizes it in place, and never writes to it except its own sandboxed `.LoomTrash/` and `.tmp-upload/` subdirectories. |
| `LOOM_CACHE_PATH` | `./data/cache` | Yes (pick a path with enough free space) | Host path bind-mounted to `/cache`. Holds generated thumbnails, previews, and HLS video segments — entirely derived data, safe to delete (Loom will regenerate it, at the cost of a rescan + re-generation pass). |

## Network

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `LOOM_BIND` | `127.0.0.1` | No | Host bind address for the web app's port. Keep this at `127.0.0.1` unless Loom is the only thing on the host and you understand the exposure — normally you reach Loom through a reverse proxy (see [REVERSE-PROXY.md](REVERSE-PROXY.md)), not by exposing the container port directly. |
| `LOOM_PORT` | `8085` | No | Host port the web app listens on. |

## Database

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `POSTGRES_PASSWORD` | — | **Yes** | Password for the `loom` PostgreSQL user. The installer generates a random one; if setting manually, use something long and random. |
| `DATABASE_URL` | constructed automatically in `compose.yml` from `POSTGRES_PASSWORD` | No | Only set this yourself if running outside Docker Compose (e.g. against an external PostgreSQL instance). |

## Authentication (better-auth)

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | — | **Yes** | Secret used to sign sessions. The installer generates a random 48-byte value. Changing this invalidates all existing sessions. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | **Yes in production** | The public URL Loom is served at (e.g. `https://loom.example.com`). Used to construct auth callback URLs. |
| `TRUSTED_ORIGINS` | empty | Recommended | Comma-separated list of origins allowed to make authenticated requests (e.g. `https://loom.example.com,http://localhost:8085`). Include every hostname/port you'll actually access Loom from. |

## Next.js

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `NODE_ENV` | `production` | No | Standard Node environment flag. |
| `NEXT_TELEMETRY_DISABLED` | `1` | No | Disables Next.js's anonymous telemetry collection. |

## Advanced: in-container path overrides

These are read inside the containers, not typically something you'd set — they exist so the code isn't hardcoded to Docker's mount points, for anyone running Loom outside Docker Compose:

| Variable | Default | Purpose |
|---|---|---|
| `MEDIA_ROOT` | `/media` | In-container path to the media root (overrides the compose bind-mount target). |
| `CACHE_ROOT` | `/cache` | In-container path to the cache root. |

Leave these unset in a normal Docker Compose deployment.
