# Configuration

All config is environment variables in .env at the repo root, which Docker Compose loads for each service. .env.example has the defaults, and the installer copies it to .env.

## Storage paths

LOOM_MEDIA_PATH is the host folder mounted to /media in both containers, this is your file library. It defaults to ./data/media but you should point it at your real files. Loom reads it in place and only writes to its own .LoomTrash/ and .tmp-upload/ subfolders.

LOOM_CACHE_PATH is the host folder mounted to /cache, defaulting to ./data/cache. Pick somewhere with free space. It holds generated thumbnails, previews, and HLS segments, all derived and safe to delete, Loom rebuilds it on the next scan and generation pass.

## Network

LOOM_BIND is the host address the web app's port binds to, default 127.0.0.1. Leave it there unless Loom is the only thing on the host and you know what you're doing, normally you reach Loom through a reverse proxy (see [REVERSE-PROXY.md](REVERSE-PROXY.md)) rather than exposing the port directly. LOOM_PORT is the host port for the web app, default 8085.

## Database

POSTGRES_PASSWORD is the password for the loom PostgreSQL user, and it's required. The installer makes a random one, if you set it yourself make it long and random. DATABASE_URL is built automatically in compose.yml from POSTGRES_PASSWORD, you'd only set this yourself if running outside Docker Compose, against an external PostgreSQL for example.

## Login (better-auth)

BETTER_AUTH_SECRET signs login sessions and is required. The installer generates a random 48-byte value. loom-web refuses to start if it's missing, shorter than 32 characters, or still the example value. Changing it logs everyone out. BETTER_AUTH_URL is the public URL Loom is served at, like https://loom.example.com. It's required in production: it's used to build auth callback URLs and the share links you hand out (`https://loom.example.com/s/…`). Set it to the address people outside your network will use. TRUSTED_ORIGINS is a comma-separated list of origins allowed to make logged-in requests, like https://loom.example.com,http://localhost:8085. It's recommended and defaults to empty. List every hostname and port you'll actually use.

Share links are off until the Owner enables them in Settings, then Sharing. Links are encrypted with a key derived from BETTER_AUTH_SECRET, so changing the secret doesn't break existing links, but they can't be copied from the UI again.

Public sign-up is always disabled. The first account is created on the setup page, and after that the Owner adds users in Settings, then Users. Sign-in attempts are rate-limited to 10 per minute per IP address.

## Uploads and background work

These all have sensible defaults. Leave them unset unless you have a reason.

- **LOOM_UPLOAD_CHUNK_MB** (default 32, maximum 95) is the size of each upload chunk. Keep it below your proxy's request-size limit. Cloudflare's is 100 MB, and nginx's `client_max_body_size` must be at least this.
- **LOOM_MAX_UPLOAD_GB** (default: no limit) caps the size of a single upload. Uploads are always refused if they would leave less than 256 MB free on the drive.
- **LOOM_WORKER_CONCURRENCY** (default 2, maximum 8) sets how many files the scanner processes in parallel (thumbnails, previews, video posters). Raise it on a machine with more cores; lower it to 1 on a Raspberry Pi.
- **LOOM_SHARP_THREADS** (default 2) sets how many threads the image library uses per job.
- **LOOM_MAX_TRANSCODES** (default 2) sets how many videos can be converted for streaming at the same time. Each one uses roughly one CPU core.
- **LOOM_AUDIT_RETENTION_DAYS** (default 180) sets how long audit log entries are kept.

## Next.js

NODE_ENV defaults to production, it's the standard Node environment flag. NEXT_TELEMETRY_DISABLED defaults to 1 and turns off Next.js's anonymous telemetry.

## Advanced, container path overrides

These are read inside the containers and you normally wouldn't set them, they exist so the code isn't hardcoded to Docker's mount points, for anyone running Loom outside Docker Compose. MEDIA_ROOT defaults to /media inside the container, CACHE_ROOT defaults to /cache. Leave both unset in a normal Docker Compose setup.
