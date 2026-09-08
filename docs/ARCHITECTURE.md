# Architecture

## Overview

Loom is three containers behind Docker Compose:

- **`loom-web`** — Next.js 15 app (App Router, standalone build). Serves the UI, the API, authentication, and file streaming.
- **`loom-scanner`** — a long-running Node.js worker that indexes the filesystem into PostgreSQL and generates derived media (thumbnails, previews, HLS segments). It does its work by polling a DB-backed job queue, not a filesystem watcher.
- **`postgres`** — metadata only. No original file content is ever stored in the database.

Two bind-mounted volumes are shared between `loom-web` and `loom-scanner`:

| In-container path | What it holds | Who owns the content |
|---|---|---|
| `/media` | Your actual files | You. Loom treats this as read-mostly and never reorganizes it. |
| `/cache` | Thumbnails, previews, HLS segments | Loom. Entirely derived — safe to wipe and regenerate. |

**The filesystem is the source of truth.** If the database and the filesystem ever disagree, the filesystem wins — the database is an index, not a system of record.

## The idle-drive principle

Loom is designed around one constraint: many self-hosters run it against external or spun-down drives (USB drives, network mounts, drives with aggressive power management) that they don't want woken up unnecessarily. So:

- **No filesystem watcher.** Loom does not use `chokidar` or `inotify` to watch for changes in real time — that would mean holding the drive open and busy indefinitely.
- **No scan on startup.** Restarting the containers does not trigger a rescan.
- **Rescans are explicit and metadata-first.** An Owner triggers a rescan from Settings → Scanner. The scanner walks the directory tree comparing `size` + `mtime` against what's already indexed (`sourceVersion = "${size}-${mtimeMs}"`) — files that haven't changed are skipped entirely, without reading their content.
- **Content hashing is lazy.** Loom needs a stronger identity than size+mtime to safely deduplicate derived media (see below), but computing a full hash means reading the whole file. So that hash is only computed the first time a file is actually read for another reason — generating a thumbnail, probing a video, an internal copy operation — never as a blanket step during a routine scan.

## Content-based deduplication

If the same file exists at 10 different paths (a common result of manual copying over the years), Loom stores exactly one thumbnail, one preview, and one HLS cache for it — not 10.

This works via a `ContentIdentity` record, keyed by `size` + a **fast hash**: SHA-256 of the first 1MB and last 1MB of the file, not the whole thing. This is a reliable *candidate* identity for deduplication purposes (collisions are vanishingly unlikely for real-world file variety) computed in milliseconds even for a 50GB video, rather than a mathematical proof of bit-identical content.

The fast hash is computed lazily (see above) and cached on first computation. `FileNode` rows (one per filesystem path) point to a shared `ContentIdentity`; thumbnails/previews/HLS caches are attached to the `ContentIdentity`, not to any individual path. Each cache entry also carries a `profileVersion`, so if generation settings change later (e.g. a new thumbnail size), old caches aren't incorrectly reused.

When the last `FileNode` referencing a `ContentIdentity` is gone (including from Trash), the scanner's orphan garbage collection phase deletes the `ContentIdentity` and its physical cache files.

## Video streaming

Loom probes videos with `ffprobe` on first access. Natively browser-compatible files (most H.264 MP4s) are served directly via HTTP range requests — no transcoding at all. Incompatible formats (HEVC, MOV, MKV, AVI, older MPEG, etc.) are served via **region-based HLS**:

- A full-duration HLS manifest is synthesized instantly from the probed duration — the player sees the whole timeline immediately, with no wait for a full transcode.
- FFmpeg is only invoked for the specific timeline region actually requested (e.g. when a user seeks), and only that region is transcoded.
- Concurrent requests for the same region are deduplicated into a single FFmpeg process.
- Idle FFmpeg processes are torn down after 30 seconds; completed segments are preserved on disk.
- Segments are written atomically (temp file + rename) so a player is never served a partially-written, truncated segment.

## Trash

Deletions are never immediate. A deleted item is physically moved into `/media/.LoomTrash/` (a directory the scanner ignores during indexing) and its `FileNode` is marked `inTrash = true`, retaining its original path for restoration. Items are automatically purged 15 days after deletion. Restoring to a path that's since been reoccupied by something else stops with a conflict rather than silently overwriting or renaming — Loom never guesses in a way that could destroy data.

## Access control

Two roles: **Owner** (unrestricted) and **Family**. Family users' visibility is governed by path-based ACL rules — the deepest matching rule for a given path wins, and rules can be layered (deny a parent directory, then allow a specific subdirectory within it). Every mutating action across the app is recorded in an audit log.

## Uploads

Uploads stream into a sandboxed `/media/.tmp-upload/` staging area (also ignored by the scanner), then are atomically moved into their destination on completion. Filename collisions during upload are resolved with automatic Windows-style renaming (`file (1).jpg`) rather than prompting — uploads are expected to "just work." Copy/move/rename operations initiated from within the UI, by contrast, always ask before overwriting anything.

## Database schema & migrations

The schema lives in `web/prisma/schema.prisma`; a byte-identical copy lives in `scanner/prisma/schema.prisma` purely so the scanner's own Docker image can generate a matching Prisma client at build time (`scripts/sync-schema.sh` checks the two stay in sync — run it, or `--fix`, if you ever hand-edit one). Migrations are tracked in `web/prisma/migrations/` and applied automatically by `loom-web`'s container entrypoint on every startup (`prisma migrate deploy`) — there's no separate migration step to remember.
