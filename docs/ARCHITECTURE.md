# How Loom works

## The pieces

Loom runs as three containers with Docker Compose:

- **`loom-web`** is the Next.js 15 app (App Router, standalone build). It serves the UI, the API, login, and file streaming.
- **`loom-scanner`** is a Node worker that runs all the time. It indexes the filesystem into PostgreSQL and makes the derived media (thumbnails, previews, HLS video segments). It gets work from a job queue in the database, not from watching the filesystem.
- **`postgres`** holds metadata only. No actual file content ever goes in the database.

`loom-web` and `loom-scanner` share two bind-mounted folders:

| Path in the container | What's in it | Who owns it |
|---|---|---|
| `/media` | Your files | You. Loom mostly just reads this and never rearranges it. |
| `/cache` | Thumbnails, previews, HLS segments | Loom. All generated, safe to delete. |

The filesystem is the source of truth. If the database and the filesystem disagree, the filesystem wins. The database is an index, nothing more.

## Keeping the drive idle

A lot of people run Loom against a drive they don't want woken up all the time: a USB drive, a network mount, a drive with aggressive power saving. So Loom is built to leave it alone.

- **No filesystem watcher.** No `inotify`, no `chokidar`. Watching would keep the drive busy forever.
- **No scan on startup.** Restarting the containers doesn't start a scan.
- **Rescans are manual and check metadata first.** The Owner starts a rescan from Settings, then Scanner. The scanner walks the folder tree and compares `size` and `mtime` to what's already indexed (`sourceVersion = "${size}-${mtimeMs}"`). Files that didn't change are skipped without reading them.
- **Hashing happens later, not during a scan.** Loom needs something stronger than size and mtime to dedup safely (see below). That means reading the whole file, so it only does it the first time a file gets read for some other reason: making a thumbnail, probing a video, an internal copy. Never as a blanket step in a scan.

## Deduplicating by content

If the same file sits at 10 different paths (which happens after years of copying things around), Loom keeps one thumbnail, one preview, and one HLS cache for it, not 10.

It does this with a `ContentIdentity` record keyed by `size` plus a fast hash: a SHA-256 of the first 1MB and the last 1MB of the file, not the whole thing. That's enough to treat two files as the same for caching, and it takes milliseconds even on a 50GB video. It isn't a proof that every byte matches.

The fast hash is computed lazily and saved the first time. Each `FileNode` (one per path) points at a shared `ContentIdentity`. Thumbnails, previews, and HLS caches hang off the `ContentIdentity`, not off any one path. Each cache entry also has a `profileVersion`, so if generation settings change later (a new thumbnail size, say), the old caches don't get reused by mistake.

When the last `FileNode` pointing at a `ContentIdentity` is gone (trash included), the scanner's cleanup phase deletes the `ContentIdentity` and its cache files.

## Video streaming

Loom runs `ffprobe` on a video the first time someone opens it. Videos the browser can play (most H.264 MP4s) are served straight over HTTP range requests, no converting. Everything else (HEVC, MOV, MKV, AVI, old MPEG) goes through region-based HLS:

- Loom builds a full-length HLS playlist right away from the probed duration. The player sees the whole timeline immediately.
- FFmpeg only runs for the part of the timeline someone actually asks for, like when they seek. Only that part gets converted.
- If two people ask for the same part at once, they share one FFmpeg process.
- FFmpeg processes that sit idle get shut down after 30 seconds. Finished segments stay on disk.
- Segments are written with a temp file and a rename, so the player never gets a half-written one.

## Trash

Deletes aren't immediate. A deleted item moves into `/media/.LoomTrash/` (a folder the scanner skips) and its `FileNode` gets `inTrash = true` while keeping its old path for restore. Items are purged 15 days after deletion. If you try to restore to a path that's since been taken by something else, Loom stops with a conflict instead of overwriting or renaming. It won't guess in a way that could lose data.

## Permissions

Two roles: **Owner** (can see and do everything) and **Family**. What a Family user sees is controlled by path rules. The deepest rule that matches a path wins, and you can stack them: deny a folder, then allow one subfolder inside it. Every change anywhere in the app goes in an audit log.

## Uploads

Uploads land in `/media/.tmp-upload/` first (also skipped by the scanner), then move into place once they finish. If an upload's name collides with an existing file, Loom renames it Windows-style (`file (1).jpg`) instead of asking. Uploads should just work. Copy, move, and rename inside the UI do ask before overwriting anything.

## Schema and migrations

The schema is in `web/prisma/schema.prisma`. An identical copy is in `scanner/prisma/schema.prisma` so the scanner's Docker image can generate a matching Prisma client at build time. `scripts/sync-schema.sh` checks the two match; run it (or `--fix`) if you edit one by hand. Migrations live in `web/prisma/migrations/` and run automatically when `loom-web`'s container starts (`prisma migrate deploy`). There's no separate migration step.
