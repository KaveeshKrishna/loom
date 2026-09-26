# Troubleshooting

## Permission denied writing to cache

Both loom-web and loom-scanner run as the node user, UID/GID 1000:1000, that's the first regular user on most Linux distros. If your LOOM_CACHE_PATH folder was made by a different user or by root, Loom can't write thumbnails, previews, or HLS segments into it. The scanner then stops at startup with "Can't write to the cache folder".

Fix:
```bash
sudo chown -R 1000:1000 /path/to/your/cache
```

scripts/install.sh tries this for a folder it just made, but it can't if it doesn't have permission to chown, not run with sudo, folder isn't yours. It warns you when that happens. On start, the scanner also gives root-owned cache files (left by versions before 2.0, which ran it as root) to uid 1000 by itself.

LOOM_MEDIA_PATH is your data, so no script ever chowns it. uid 1000 needs to be able to read it to show your files, and write to it for uploads, renames, moves, edits and Trash. Loom keeps its own working files in the .LoomTrash/ and .tmp-upload/ subfolders, which it makes itself.

## New files on the drive don't show up

Files you upload or change through Loom show up straight away. Files copied onto the drive some other way (over SMB, or by plugging the drive into another computer) don't, because Loom doesn't watch the filesystem (see [How Loom works](ARCHITECTURE.md#keeping-the-drive-idle)). They show up after a rescan: Settings, then Scanner, then Scan Now, Owner only. Check Settings then Scanner for job status and errors if a rescan misses something.

## An upload is stuck or keeps retrying

Uploads go in chunks (32 MB by default) and each one is retried on its own, so a flaky connection only slows things down. If every chunk fails, it's usually the reverse proxy: its request body limit has to be larger than the chunk size. See [Reverse proxy](REVERSE-PROXY.md). If you can't raise the limit, lower LOOM_UPLOAD_CHUNK_MB instead.

If the page was closed mid-upload, pick the same file again (same folder) and Loom continues where it stopped. Unfinished uploads are cleaned up after 24 hours.

## Thumbnails or live updates don't appear until I refresh

New thumbnails and changes made by others arrive over a live connection to /api/events. If your reverse proxy buffers responses, they arrive late or not at all. Turn buffering off for that path, see [Reverse proxy](REVERSE-PROXY.md). When the live connection is down, Loom checks every few seconds while something is still processing, so it catches up.

## A video won't play or keeps buffering

Watch docker compose logs -f loom-web for [HLS] and [HLS-seg] lines while you try to play it. The first request for a new region of an incompatible video waits for FFmpeg to make that segment, a few seconds is normal for big or high-bitrate files. If it never finishes, the container might be short on resources, HLS transcoding is CPU-heavy, check docker stats. If you saw errors earlier and the browser cached a broken segment, hard-refresh or clear site data for the Loom origin before assuming the server is still broken. You can also check FFmpeg works in the container with docker compose exec loom-web ffmpeg -version.

## A file says Corrupt or Unsupported and I don't think it should

Check File Health in the sidebar, it tells the two apart. Unsupported means the file is fine, but Loom's thumbnail/preview/probe pipeline doesn't handle that format, nothing is lost. Corrupt means Loom tried to read the file and it looks damaged, a cut-off video with no moov atom for example.

Both are tied to the file's size and mtime at the time of the check. Replace the file with a good copy and a rescan re-checks it. To re-check without a rescan (say, after updating Loom), use Check again on the File Health page, for one file or for everything listed.

## Setup page won't let me make an account, or says setup is done

The /setup page and its API only work while the user table is empty, that's on purpose, so it can't be used to make a second Owner later. To add users after setup, use Settings, then Users, as the Owner.

## I forgot my password

Another Owner can set a new one in Settings, then Users. If you're the only Owner, reset it from the server:

```bash
docker compose exec loom-web node scripts/reset-password.mjs you@example.com
```

It asks for the new password (without showing it) and signs that account out everywhere. It needs shell access to the server, so it doesn't open anything to the outside.

## Scanner container keeps restarting

```bash
docker compose logs loom-scanner --tail=100
```

Usual causes are:
- LOOM_MEDIA_PATH not existing or not being readable by uid 1000. Check the path in .env is really there on the host.
- The cache folder not being writable by uid 1000, see "Permission denied writing to cache" above.
- The database not being up yet. The scanner needs postgres healthy, check docker compose ps.

## An update failed

update.sh shows the log and offers to roll back. You can also do it later with `./scripts/update.sh --rollback`. Your media is never touched by updates, and the database was backed up (and the backup checked) before anything changed; the file is in backups/. See [Upgrading](UPGRADING.md).

If update.sh says you have local changes, you edited one of Loom's files, see "Local changes" in [Upgrading](UPGRADING.md).

## Schema drift between web/ and scanner/

If you edited web/prisma/schema.prisma without editing scanner/prisma/schema.prisma, or the other way around, the scanner's Prisma client can disagree with the real database. Run:

```bash
./scripts/sync-schema.sh          # checks, exits non-zero if out of sync
./scripts/sync-schema.sh --fix    # copies web's schema over scanner's
```

## Still stuck

Open an issue with docker compose logs --tail=200 for the affected service, your Loom version or commit, and whether it's a fresh install or an upgrade, and from what version.
