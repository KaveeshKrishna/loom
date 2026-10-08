# Troubleshooting

Start with the logs. Most problems explain themselves there:

```bash
docker compose ps                          # are all three services up and healthy?
docker compose logs --tail=200 loom-web
docker compose logs --tail=200 loom-scanner
```

## Permission denied writing to cache

Both loom-web and loom-scanner run as the `node` user, UID/GID `1000:1000`, the first regular user on most Linux distros. If your `LOOM_CACHE_PATH` folder was created by a different user or by root, Loom can't write thumbnails, previews or video segments into it, and the scanner stops at startup with "Can't write to the cache folder".

Fix:

```bash
sudo chown -R 1000:1000 /path/to/your/cache
```

`scripts/install.sh` does this for a cache folder it creates, but can't if it lacks permission to `chown` (not run with sudo, folder isn't yours); it warns you when that happens. On start, the scanner also hands root-owned cache files left by versions before 2.0 (which ran it as root) to uid 1000 by itself.

`LOOM_MEDIA_PATH` is your data, so no script ever chowns it. uid 1000 needs to be able to **read** it to show your files, and **write** to it for uploads, renames, moves, edits and Trash. See [Installation → File permissions](INSTALLATION.md#file-permissions).

## New files on the drive don't show up

Files you upload or change **through Loom** show up straight away. Files copied onto the drive some other way (over SMB, rsync, or by plugging the drive into another computer) don't, because Loom doesn't watch the filesystem (see [How Loom works](ARCHITECTURE.md#keeping-the-drive-idle)). They appear after a rescan: **Settings → Scanner → Scan Now** (Owner only).

If a rescan misses something, check Settings → Scanner for the job's status and errors. If the scan stops early saying the media folder looks empty, the drive probably isn't mounted: Loom refuses to remove index entries when the media root is empty but the index isn't.

## An upload is stuck or keeps retrying

Uploads go in chunks (32 MB by default) and each one is retried on its own, so a flaky connection only slows things down. If **every** chunk fails, it's almost always the reverse proxy: its request body limit has to be larger than the chunk size. See [Reverse proxy](REVERSE-PROXY.md). If you can't raise the limit, lower `LOOM_UPLOAD_CHUNK_MB` instead.

If the page was closed mid-upload, pick the same file again in the same folder and Loom continues where it stopped. Unfinished uploads are cleaned up after 24 hours.

Uploads are also refused when they'd leave less than 256 MB free on the drive, or when a file is larger than `LOOM_MAX_UPLOAD_GB` (if you've set it).

## The server lost power (or crashed) during an upload or copy

Nothing half-finished ends up in your folders:

- **Uploads:** every file that shows in a folder is complete (each chunk was checksummed and flushed to disk). Partial data sits hidden in `.tmp-upload/` inside the media folder. The upload panel lists unfinished uploads when you open Loom: pick the same files again in the same folder to resume, or Discard. Leftovers are deleted automatically after 24 hours.
- **Folder uploads:** pick the same folder again and choose Skip with "Do this for the other N conflicts". Files that already made it are skipped and the rest are uploaded, with no duplicates.
- **Copies:** files that finished copying are complete. The one being copied was a hidden temp file and is deleted when Loom starts again. Run the copy again with Skip for all to finish it.
- **Text edits:** the file is either the old version or the new one, never a mix. The previous version is in Trash.

When Loom starts after an interruption, `docker compose logs loom-web` shows a `[recovery]` line with what it cleaned up. To see how much space unfinished uploads use, open **Settings → Storage** (it has a Clean up button), or run `sudo du -sh <your LOOM_MEDIA_PATH>/.tmp-upload`.

## Thumbnails or live updates don't appear until I refresh

New thumbnails and changes made by others arrive over a live connection to `/api/events`. If your reverse proxy buffers responses, they arrive late or not at all. Turn buffering off for that path, see [Reverse proxy](REVERSE-PROXY.md). When the live connection is down, Loom polls every few seconds while something is still processing, so it catches up eventually.

If thumbnails never appear at all, check `docker compose logs loom-scanner` for errors and Settings → Scanner for failed processing jobs.

## A video won't play or keeps buffering

- Watch `docker compose logs -f loom-web` for `[HLS]` and `[HLS-seg]` lines while you try to play it.
- The first request for a new region of a video that needs converting waits for FFmpeg to produce that segment. A few seconds is normal for large or high-bitrate files.
- If it never finishes, the container may be short on CPU (conversion is CPU-heavy). Check `docker stats`, and consider lowering `LOOM_MAX_TRANSCODES` on small machines.
- If you saw errors earlier and the browser cached a broken segment, hard-refresh or clear site data for Loom before assuming the server is still broken.
- Confirm FFmpeg works inside the container: `docker compose exec loom-web ffmpeg -version`.
- Behind a proxy, make sure its read timeout is at least 60 seconds.

## A file says Corrupt or Unsupported and I don't think it should

**File Health** in the sidebar tells the two apart:

- **Unsupported** means the file is fine, but Loom's thumbnail, preview or probe pipeline doesn't handle that format (RAW photos, for example). Nothing is lost.
- **Corrupt** means Loom tried to read the file and it looks damaged, e.g. a cut-off video with no `moov atom`.

Both are tied to the file's size and modification time at the time of the check. Replace the file with a good copy and a rescan re-checks it. To re-check without a rescan (say, after updating Loom), use **Check again** on the File Health page, for one file or for everything listed.

## The setup page won't let me create an account, or says setup is done

The `/setup` page and its API only work while there are no users at all. That's deliberate, so it can never be used to create a second Owner later. To add users after setup, use **Settings → Users** as the Owner.

## I forgot my password

Another Owner can set a new one in **Settings → Users**. If you're the only Owner, reset it from the server:

```bash
docker compose exec loom-web node scripts/reset-password.mjs you@example.com
```

It asks for the new password (without echoing it) and signs that account out everywhere. It needs shell access to the server, so it doesn't open anything to the outside. To run it without a prompt, pass the password in `LOOM_NEW_PASSWORD`.

## loom-web won't start

```bash
docker compose logs --tail=100 loom-web
```

Common causes:

- **`BETTER_AUTH_SECRET is missing or still the example value`.** Set a real secret in `.env` (`openssl rand -base64 48`) and run `docker compose up -d`.
- **A migration error.** See [Upgrading → If a migration fails](UPGRADING.md#if-a-migration-fails).
- **Still starting.** After an update the first start runs migrations, which can take a few minutes on a big library. `docker compose ps` shows `(health: starting)` until it's done.

## The scanner container keeps restarting

```bash
docker compose logs --tail=100 loom-scanner
```

Usual causes:

- `LOOM_MEDIA_PATH` doesn't exist or isn't readable by uid 1000. Check the path in `.env` really exists on the host.
- The cache folder isn't writable by uid 1000, see [Permission denied writing to cache](#permission-denied-writing-to-cache).
- The database isn't up yet. The scanner needs postgres healthy; check `docker compose ps`.

## An update failed

`update.sh` shows the log and offers to roll back. You can also do it later with `./scripts/update.sh --rollback`. Your media is never touched by updates, and the database was backed up (and the backup verified) before anything changed; the file is in `backups/`. See [Upgrading](UPGRADING.md).

If `update.sh` says you have local changes, you edited one of Loom's tracked files; see [Upgrading → Local changes](UPGRADING.md#local-changes).

## Schema drift between web/ and scanner/

If `web/prisma/schema.prisma` was edited without updating `scanner/prisma/schema.prisma` (or the other way round), the scanner's Prisma client can disagree with the real database. Run:

```bash
./scripts/sync-schema.sh          # checks; exits non-zero if out of sync
./scripts/sync-schema.sh --fix    # copies web's schema over scanner's
```

## Still stuck?

Open an issue with:

- `docker compose logs --tail=200` for the affected service;
- your Loom version (`cat VERSION`, or `curl -s http://127.0.0.1:8085/api/health`);
- whether this is a fresh install or an upgrade, and from which version;
- whether it happens with all files or only some (and what kind).

For anything security-related, don't open a public issue; see [SECURITY.md](../SECURITY.md).
