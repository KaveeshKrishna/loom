# Troubleshooting

## Permission denied writing to cache

The `loom-web` container runs as the `node` user, UID/GID `1000:1000`. That's the first regular user on most Linux distros, but if your `LOOM_CACHE_PATH` folder was made by a different user or by root, Loom can't write thumbnails, previews, or HLS segments into it.

Fix:
```bash
sudo chown -R 1000:1000 /path/to/your/cache
```

`scripts/install.sh` tries this for a folder it just made, but it can't if it doesn't have permission to `chown` (not run with sudo, folder isn't yours). It warns you when that happens.

`LOOM_MEDIA_PATH` doesn't need this. Loom only reads most of it, plus writes to its own `.LoomTrash/` and `.tmp-upload/` subfolders, which it makes itself.

## New files on the drive don't show up

Loom doesn't watch the filesystem (see [How Loom works](ARCHITECTURE.md#keeping-the-drive-idle)). New files show up after a manual rescan: **Settings, then Scanner, then Scan Now** (Owner only). Check **Settings, then Scanner** for job status and errors if a rescan misses something.

## A video won't play or keeps buffering

- Watch `docker compose logs -f loom-web` for `[HLS]` and `[HLS-seg]` lines while you try to play it.
- The first request for a new region of an incompatible video waits for FFmpeg to make that segment. A few seconds is normal for big or high-bitrate files. If it never finishes, the container might be short on resources (HLS transcoding is CPU-heavy). Check `docker stats`.
- If you saw errors earlier and the browser cached a broken segment, hard-refresh or clear site data for the Loom origin before assuming the server is still broken.
- Check FFmpeg works in the container: `docker compose exec loom-web ffmpeg -version`.

## A file says "Corrupt" or "Unsupported" and I don't think it should

Check **File Health** in the sidebar. It tells the two apart:
- **Unsupported** means the file is fine, but Loom's thumbnail/preview/probe pipeline doesn't handle that format. Nothing is lost.
- **Corrupt** means Loom tried to read the file and it looks damaged (a cut-off video with no `moov atom`, for example).

Both are tied to the file's size and mtime at the time of the check. Replace the file with a good copy and a rescan re-checks it. There's also a "Retry Analysis" button on the File Health page that re-checks without a full rescan.

## Setup page won't let me make an account, or says setup is done

The `/setup` page and its API only work while the user table is empty. That's on purpose, so it can't be used to make a second Owner later. To add users after setup, use **Settings, then Users** as the Owner.

If you're locked out completely (lost the Owner password, no other Owner), you need direct database access to reset it. There's no password reset flow yet.

## Scanner container keeps restarting

```bash
docker compose logs loom-scanner --tail=100
```

Usual causes:
- `LOOM_MEDIA_PATH` doesn't exist or the container can't read it. Check the path in `.env` is really there on the host.
- The database isn't up yet. The scanner needs `postgres` healthy. Check `docker compose ps`.

## Schema drift between web/ and scanner/

If you edited `web/prisma/schema.prisma` without editing `scanner/prisma/schema.prisma` (or the other way around), the scanner's Prisma client can disagree with the real database. Run:

```bash
./scripts/sync-schema.sh          # checks, exits non-zero if out of sync
./scripts/sync-schema.sh --fix    # copies web's schema over scanner's
```

## Still stuck

Open an issue with:
- `docker compose logs --tail=200` for the service involved
- Your Loom version or commit
- Whether it's a fresh install or an upgrade, and from what version
