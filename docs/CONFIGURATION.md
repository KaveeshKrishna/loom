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

BETTER_AUTH_SECRET signs login sessions and is required, the installer generates a random 48-byte value. Changing it logs everyone out. BETTER_AUTH_URL is the public URL Loom is served at, like https://loom.example.com, required in production, it's used to build auth callback URLs. TRUSTED_ORIGINS is a comma-separated list of origins allowed to make logged-in requests, like https://loom.example.com,http://localhost:8085, it's recommended and defaults to empty. List every hostname and port you'll actually use.

## Next.js

NODE_ENV defaults to production, it's the standard Node environment flag. NEXT_TELEMETRY_DISABLED defaults to 1 and turns off Next.js's anonymous telemetry.

## Advanced, container path overrides

These are read inside the containers and you normally wouldn't set them, they exist so the code isn't hardcoded to Docker's mount points, for anyone running Loom outside Docker Compose. MEDIA_ROOT defaults to /media inside the container, CACHE_ROOT defaults to /cache. Leave both unset in a normal Docker Compose setup.
