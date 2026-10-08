# Installation

## Requirements

- **Docker Engine and Docker Compose v2.** `docker compose version` should work.
- **A folder of files to manage**, and free disk space on a **separate** path for the cache (thumbnails, previews, converted video segments). The cache must not be inside the media folder, because Loom deletes cache files freely. See [How Loom works](ARCHITECTURE.md) for why they're separate.
- **`git`, `openssl` and `curl`** on the host. The installer uses them; all three come with almost every Linux install.

Loom is developed and tested on Linux. It should run anywhere Docker runs, but the path and permission notes below assume Linux.

## One-command install

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
./scripts/install.sh
```

The installer:

1. Checks that Docker and Docker Compose are installed and the Docker daemon is running.
2. Asks where your files live (`LOOM_MEDIA_PATH`), where the cache should go (`LOOM_CACHE_PATH`), the bind address and port, and the public URL you'll use.
3. Refuses a cache folder that is the media folder or sits inside it. If the media folder doesn't exist, it asks before creating it, so a typo doesn't leave you with an empty library.
4. Generates `.env` from `.env.example`, filling in a random `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET`.
5. Creates the media and cache folders if they're missing, and gives the cache folder to uid 1000 (if that fails, see [Troubleshooting](TROUBLESHOOTING.md#permission-denied-writing-to-cache)). It never changes ownership of an existing media folder: that's your data.
6. Builds the Docker images, starts the containers, and waits for `/api/health` to report ready.

It's safe to re-run at any time. If a `.env` already exists, the installer uses its settings instead of asking again and never overwrites it. It stops if that `.env` still contains an example password or secret.

### Non-interactive install

For CI or scripted provisioning, export the settings first and pass `--non-interactive`:

```bash
LOOM_MEDIA_PATH=/mnt/media \
LOOM_CACHE_PATH=/mnt/cache \
LOOM_BIND=127.0.0.1 \
LOOM_PORT=8085 \
BETTER_AUTH_URL=https://loom.example.com \
  ./scripts/install.sh --non-interactive
```

## Manual install

If you'd rather do it by hand, or need to change something the installer doesn't ask about:

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
cp .env.example .env
```

Edit `.env` and set at least:

| Variable | Value |
|---|---|
| `LOOM_MEDIA_PATH` | Host path to your files |
| `LOOM_CACHE_PATH` | Host path for the cache (outside the media folder) |
| `POSTGRES_PASSWORD` | A strong random password, e.g. `openssl rand -hex 24` |
| `BETTER_AUTH_SECRET` | A long random string, e.g. `openssl rand -base64 48`. Loom refuses to start with the example value. |
| `BETTER_AUTH_URL` | The public URL you'll access Loom at, e.g. `https://loom.example.com` |
| `TRUSTED_ORIGINS` | Every origin you'll use, comma-separated |

See [Configuration](CONFIGURATION.md) for every variable. Then make sure the cache folder is writable by uid 1000 (see below) and start Loom:

```bash
docker compose build
docker compose up -d
docker compose ps        # wait until loom-web shows (healthy)
```

Database migrations run automatically when loom-web starts (see `web/docker-entrypoint.sh`). There is no separate migration step. On a very large library, the first start after an update can take a few minutes while a migration runs; loom-web shows as starting until it's done.

## File permissions

Both loom-web and loom-scanner run as uid 1000 (the `node` user inside the containers), never as root.

- **Media folder.** uid 1000 must be able to **read** it to show your files, and **write** to it for uploads, renames, moves, text edits and Trash. The simplest setup is a media folder owned by uid 1000, which is the first regular user on most Linux systems. If it belongs to someone else, grant uid 1000 access with group permissions or ACLs rather than changing the owner of everything. No Loom script ever changes ownership of your media.
- **Cache folder.** Must be writable by uid 1000. The installer sets this up for a folder it creates. For an existing folder: `sudo chown -R 1000:1000 /path/to/cache`.

Loom keeps its own working files inside the media folder in two hidden folders it creates itself: `.LoomTrash/` (Trash) and `.tmp-upload/` (unfinished uploads and the crash-recovery journal). The scanner skips both.

## First login

Open Loom in your browser. A fresh install with no users shows a **setup page** instead of a login form; create your account there. That first account becomes the **Owner**, which has unrestricted access.

The setup page and its API only work while there are no users at all. Once an account exists the page redirects to login, and the API refuses with a 403, so it can never be used to create a second Owner, even if two setup requests arrive at the same moment.

Nobody can sign up on their own. The Owner creates further accounts in **Settings → Users**; new accounts get the **Family** role by default. A Family user can be restricted to certain folders in **Settings → Permissions**.

## After installing

- **Reachable from outside?** Put a reverse proxy or tunnel in front of Loom: [Reverse proxy](REVERSE-PROXY.md).
- **Existing files on the drive?** As the Owner, run **Settings → Scanner → Scan Now** once to index them. Files you upload through Loom are indexed automatically.
- **Share links** are off until you turn them on in **Settings → Sharing**.
- **Updating later:** `./scripts/update.sh`, see [Upgrading](UPGRADING.md).
- To understand scanning and caching before you index thousands of files, read [How Loom works](ARCHITECTURE.md).

## Uninstalling

```bash
./scripts/uninstall.sh
```

This stops and removes the containers. By default the database volume is kept, so running `install.sh` again brings back your users, index, favorites and permissions. The script asks whether to also delete the database; if you say yes (and type `delete` to confirm), it takes a final backup into `backups/` first and only deletes the database if that backup succeeds. Your media folder is never touched.
