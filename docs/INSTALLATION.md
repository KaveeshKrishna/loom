# Installing Loom

## What you need

- Docker Engine and Docker Compose v2 (`docker compose version` should work).
- A folder of files to manage, and free disk space somewhere else for the cache (thumbnails, previews, HLS segments). [How Loom works](ARCHITECTURE.md) explains why the cache is separate.
- `git`, `openssl`, and `curl` on the host. The installer uses them. All three come with almost every Linux install.

Loom is built and tested on Linux. It should run anywhere Docker does, but the path and permission notes below assume Linux.

## One command

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
./scripts/install.sh
```

The script:
1. Checks Docker and Docker Compose are there.
2. Asks where your files are (`LOOM_MEDIA_PATH`), where the cache goes (`LOOM_CACHE_PATH`), the bind address and port, and your public URL.
3. Makes `.env` from `.env.example` with random `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` values. It never overwrites an existing `.env`.
4. Makes the media and cache folders if they're missing, and fixes ownership on the cache folder. If that fails, see [Troubleshooting](TROUBLESHOOTING.md#permission-denied-writing-to-cache).
5. Builds the images and starts the containers.
6. Waits for `/api/health` to say it's ready.

You can re-run it any time. It won't touch an existing `.env` or restart running containers.

For a non-interactive install (CI, scripts), set the variables first and pass `--non-interactive`:

```bash
LOOM_MEDIA_PATH=/mnt/media \
LOOM_CACHE_PATH=/mnt/cache \
LOOM_BIND=127.0.0.1 \
LOOM_PORT=8085 \
BETTER_AUTH_URL=https://loom.example.com \
  ./scripts/install.sh --non-interactive
```

## By hand

If you'd rather do it yourself, or need to change something the script doesn't ask about:

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
cp .env.example .env
```

Edit `.env` and set at least:
- `LOOM_MEDIA_PATH`, the host path to your files
- `LOOM_CACHE_PATH`, the host path for the cache
- `POSTGRES_PASSWORD`, a strong random password (`openssl rand -hex 24`)
- `BETTER_AUTH_SECRET`, a long random string (`openssl rand -base64 48`)
- `BETTER_AUTH_URL` and `TRUSTED_ORIGINS`, the URL you'll use

[Configuration](CONFIGURATION.md) lists every variable.

Then:

```bash
docker compose build
docker compose up -d
```

Migrations run when the container starts (see `web/docker-entrypoint.sh`). There's no separate migration step.

## First login

Open Loom in a browser. A fresh install with no users shows a setup page instead of a login form. Make your account there. That first account becomes the **Owner**, which can do everything. Once any account exists, the setup page redirects to login, so nobody can use it to make a second Owner later.

More accounts (Settings, then Users, as the Owner) get the **Family** role. You can limit what they see per folder in Settings, then Permissions.

## Next

- [Reverse proxy](REVERSE-PROXY.md) if you want Loom reachable from outside your network.
- [How Loom works](ARCHITECTURE.md) to understand scanning and caching before you have thousands of files indexed.
