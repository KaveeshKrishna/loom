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
- **Sessions** last 30 days and are refreshed once a day while in use. Changing a user's password signs them out everywhere.
- **Share links** are off until the Owner enables them in Settings → Sharing. Link tokens are stored encrypted with a key derived from `BETTER_AUTH_SECRET`; changing the secret doesn't break existing links, but they can no longer be copied again from the UI.

## Uploads and background work

All optional, with sensible defaults. Leave them unset unless you have a reason.

| Variable | Default | Limits | Purpose |
|---|---|---|---|
| `LOOM_UPLOAD_CHUNK_MB` | `32` | 1 to 95 | Size of each upload chunk. Must be below your reverse proxy's request size limit (Cloudflare's is 100 MB; nginx's `client_max_body_size` must be larger than this). |
| `LOOM_MAX_UPLOAD_GB` | no limit | | Largest single file that can be uploaded. Independently, an upload is always refused if it would leave less than 256 MB free on the drive. |
| `LOOM_WORKER_CONCURRENCY` | `2` | 1 to 8 | How many files the scanner processes in parallel (thumbnails, previews, video posters, metadata). Raise it on a machine with more cores; use `1` on a Raspberry Pi. |
| `LOOM_SHARP_THREADS` | `2` | 1 to 4 | Threads the image library (sharp) uses per job. |
| `LOOM_MAX_TRANSCODES` | `2` | at least 1 | How many videos can be converted for streaming at the same time. Each uses roughly one CPU core. |
| `LOOM_AUDIT_RETENTION_DAYS` | `180` | at least 1 | How long audit log entries are kept. |

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
