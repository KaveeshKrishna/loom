# Configuration

All config is environment variables in `.env` at the repo root. Docker Compose loads it (`env_file: .env` on each service). `.env.example` has the defaults, and the installer copies it to `.env`.

## Storage paths

| Variable | Default | Required | What it's for |
|---|---|---|---|
| `LOOM_MEDIA_PATH` | `./data/media` | Yes, point it at your real files | Host folder mounted to `/media` in both containers. This is your file library. Loom reads it in place and only writes to its own `.LoomTrash/` and `.tmp-upload/` subfolders. |
| `LOOM_CACHE_PATH` | `./data/cache` | Yes, pick somewhere with free space | Host folder mounted to `/cache`. Holds generated thumbnails, previews, and HLS segments. All derived, safe to delete. Loom rebuilds it on the next scan and generation pass. |

## Network

| Variable | Default | Required | What it's for |
|---|---|---|---|
| `LOOM_BIND` | `127.0.0.1` | No | Host address the web app's port binds to. Leave it on `127.0.0.1` unless Loom is the only thing on the host and you know what you're doing. Normally you reach Loom through a reverse proxy (see [REVERSE-PROXY.md](REVERSE-PROXY.md)), not by exposing the port. |
| `LOOM_PORT` | `8085` | No | Host port for the web app. |

## Database

| Variable | Default | Required | What it's for |
|---|---|---|---|
| `POSTGRES_PASSWORD` | none | Yes | Password for the `loom` PostgreSQL user. The installer makes a random one. If you set it yourself, make it long and random. |
| `DATABASE_URL` | built automatically in `compose.yml` from `POSTGRES_PASSWORD` | No | Only set this if you run outside Docker Compose, like against an external PostgreSQL. |

## Login (better-auth)

| Variable | Default | Required | What it's for |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | none | Yes | Signs login sessions. The installer makes a random 48-byte value. Changing it logs everyone out. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Yes in production | The public URL Loom is served at, like `https://loom.example.com`. Used to build auth callback URLs. |
| `TRUSTED_ORIGINS` | empty | Recommended | Comma-separated list of origins allowed to make logged-in requests, like `https://loom.example.com,http://localhost:8085`. List every hostname and port you'll actually use. |

## Next.js

| Variable | Default | Required | What it's for |
|---|---|---|---|
| `NODE_ENV` | `production` | No | Standard Node environment flag. |
| `NEXT_TELEMETRY_DISABLED` | `1` | No | Turns off Next.js's anonymous telemetry. |

## Advanced: container path overrides

These are read inside the containers. You normally wouldn't set them. They exist so the code isn't hardcoded to Docker's mount points, for people running Loom without Docker Compose.

| Variable | Default | What it's for |
|---|---|---|
| `MEDIA_ROOT` | `/media` | Path to the media root inside the container. |
| `CACHE_ROOT` | `/cache` | Path to the cache root inside the container. |

Leave both unset in a normal Docker Compose setup.
