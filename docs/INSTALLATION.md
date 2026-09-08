# Installation

## Requirements

- Docker Engine + Docker Compose v2 (`docker compose version` should work).
- A directory of files to manage, and free disk space elsewhere for a derived-media cache (thumbnails/previews/HLS segments) — see [Architecture](ARCHITECTURE.md) for why this is a separate location from your files.
- `git`, `openssl`, and `curl` on the host (used by the installer script; all three are near-universal on Linux).

Loom has been developed and tested on Linux. It should work anywhere Docker runs, but paths and permissions guidance below assume Linux.

## One-command install

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
./scripts/install.sh
```

The script will:
1. Check that Docker and Docker Compose are available.
2. Ask where your files live (`LOOM_MEDIA_PATH`) and where to put the cache (`LOOM_CACHE_PATH`), plus the bind address/port and your public URL.
3. Generate `.env` from `.env.example`, filling in random `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` values. It never overwrites an existing `.env`.
4. Create the media/cache directories if they don't exist, and fix ownership on the cache directory (see [Troubleshooting](TROUBLESHOOTING.md#permission-denied-writing-to-cache) if this fails).
5. Build the Docker images and start the containers.
6. Wait for `/api/health` to report ready.

It's safe to re-run at any time — it won't touch an existing `.env` or clobber running containers.

For a non-interactive install (CI, scripted provisioning), export the variables first and pass `--non-interactive`:

```bash
LOOM_MEDIA_PATH=/mnt/media \
LOOM_CACHE_PATH=/mnt/cache \
LOOM_BIND=127.0.0.1 \
LOOM_PORT=8085 \
BETTER_AUTH_URL=https://loom.example.com \
  ./scripts/install.sh --non-interactive
```

## Manual install

If you'd rather do it by hand, or need to customize something the script doesn't ask about:

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
cp .env.example .env
```

Edit `.env` and set, at minimum:
- `LOOM_MEDIA_PATH` — host path to your files
- `LOOM_CACHE_PATH` — host path for the derived-media cache
- `POSTGRES_PASSWORD` — a strong random password (e.g. `openssl rand -hex 24`)
- `BETTER_AUTH_SECRET` — a long random string (e.g. `openssl rand -base64 48`)
- `BETTER_AUTH_URL` / `TRUSTED_ORIGINS` — the URL you'll access Loom at

See [Configuration](CONFIGURATION.md) for every variable.

Then:

```bash
docker compose build
docker compose up -d
```

Database migrations run automatically on container startup (see `web/docker-entrypoint.sh`) — there is no separate migration step to run by hand.

## First login

Open Loom in your browser. A fresh install with zero users automatically shows a setup page instead of a login form — create your account there. That first account is automatically promoted to the **Owner** role, which has unrestricted access. The setup page becomes unreachable (redirects to login) the moment any account exists, so it can't be used to create a second privileged account later.

Additional accounts (Settings → Users, as the Owner) get the **Family** role by default, whose visibility can be restricted per-path in Settings → Permissions.

## Next steps

- [Reverse Proxy Setup](REVERSE-PROXY.md) if you want to reach Loom from outside your local network.
- [Architecture](ARCHITECTURE.md) to understand the scanning/caching model before you have thousands of files indexed.
