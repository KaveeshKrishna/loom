# How Loom works

## Overview

Loom is three containers behind Docker Compose:

| Service | What it does |
|---|---|
| `loom-web` | Next.js 15 app (App Router, standalone build). Serves the UI and the API, handles login, streams files and video, receives uploads, and runs crash recovery on startup. |
| `loom-scanner` | A long-running Node worker. Indexes the filesystem into PostgreSQL and generates derived media: thumbnails, previews, video posters, and photo/video metadata. It takes its work from a job queue in the database, never from watching the filesystem. |
| `postgres` | PostgreSQL 17. Metadata only; no file content is ever stored in the database. |

loom-web and loom-scanner share two bind-mounted folders:

| In-container path | What it holds | Who owns the content |
|---|---|---|
| `/media` | Your files | You. Loom never rearranges them. Its own working files live only in the hidden `.LoomTrash/` and `.tmp-upload/` subfolders. |
| `/cache` | Thumbnails, previews, video posters, converted video segments | Loom. Entirely derived, safe to delete and regenerate. |

**The filesystem is the source of truth.** If the database and the filesystem ever disagree, the filesystem wins. The database is an index, not a system of record.

Both app containers run as the unprivileged `node` user (uid 1000). The scanner's entrypoint starts as root only long enough to hand root-owned files in `/cache` (left by versions before 2.0) to that user, then drops root for good. It never touches `/media`.

## Keeping the drive idle

Many people run Loom against a drive they don't want woken up all the time: a USB drive, a network mount, a disk with aggressive power saving. So Loom is built to leave the drive alone:

- **No filesystem watcher.** No inotify, no chokidar. Watching would keep the drive busy forever.
- **No scan on startup.** Restarting the containers doesn't start one.
- **Rescans are manual and metadata-only.** The Owner starts one from Settings → Scanner. The scanner walks the folder tree, loads each folder's indexed entries with one query, and compares size and mtime (`sourceVersion = "${size}-${mtimeMs}"`). Files that didn't change are skipped without being read. Symlinks are never followed.
- **Hashing is lazy.** Content hashes (see deduplication below) are only computed the first time a file is read for another reason, like making a thumbnail. Never as a blanket step in a scan.
- **Housekeeping never walks the media folder.** The hourly job expires Trash, cleans up abandoned uploads and prunes old logs, touching only `.LoomTrash/`, `.tmp-upload/` and the cache.

Changes made through Loom (uploads, edits, copies, moves) update the index immediately, so a rescan is only needed for files added or changed outside Loom.

**Unmounted-drive guard.** If the media folder is empty while the index isn't, the drive is probably not mounted. The scan stops before removing anything from the index.

## Background jobs

All background work is a row in the `scan_jobs` table:

| Job type | Queued by | Lane |
|---|---|---|
| `FULL_RESCAN` | The Owner clicking Scan Now | Rescan lane, one at a time |
| `PROCESS_FILE` | A finished upload, File Health's Check again, crash recovery of an upload, or a rescan that found new or changed photos and videos (or missing thumbnails) | Processing lane, `LOOM_WORKER_CONCURRENCY` jobs in parallel (default 2) |
| `INDEX_FILE` | Legacy (pre-2.0); still handled | Processing lane |

The two lanes are independent, so a freshly uploaded photo gets its thumbnail within seconds even while a long rescan is running.

- Jobs are claimed with `SELECT … FOR UPDATE SKIP LOCKED`, so a job is never processed twice.
- The web app sends `NOTIFY loom_jobs` whenever it queues something, so jobs start immediately. A slow poll (15 s) is only a fallback.
- Jobs left running by a crash or restart are put back in the queue when the scanner starts.
- After an update, the scanner waits for loom-web to finish the database migration instead of failing and restarting.

**What processing a file means:**

- **Photos:** one decode produces a 320 px square thumbnail and a preview of up to 1920 px, both rotated according to EXIF so phone photos aren't sideways. It also stores the dimensions and EXIF details (date taken, camera, lens, exposure, GPS).
- **Videos:** ffprobe reads the duration, codecs and resolution and decides whether the browser can play the file as-is; ffmpeg grabs a poster frame.

Originals are only ever opened for reading. Every output is written to a temp file in `/cache` and renamed into place, so nobody ever sees a half-written thumbnail. If a file changed between being queued and being processed, the newer version is processed.

## Uploads

Uploads are chunked, resumable and verified. The browser side is `web/components/layout/UploadContext.tsx`; the server side is `web/lib/uploads.ts`.

1. **Session.** The browser asks for an upload session (`POST /api/upload/sessions`). The server checks the name, the path, the user's permissions and the free disk space, then creates an empty `/media/.tmp-upload/<id>.partial`.
2. **Chunks.** The browser sends the file in chunks, 32 MB by default (`LOOM_UPLOAD_CHUNK_MB`), each as a plain `PUT` with the chunk's SHA-256 in a header. The server:
   - streams each chunk straight to disk with backpressure, so nothing is held in memory and a 50 GB video uses as much RAM as a 5 MB photo;
   - verifies the checksum and flushes the chunk to disk (`fdatasync`) before acknowledging it;
   - throws away a corrupted chunk, which the browser then re-sends automatically.

   Because each chunk is a separate request, uploads work behind proxies with body-size limits, such as Cloudflare's 100 MB.
3. **Resuming.** If the connection drops, the browser retries with backoff and asks the server how much it actually has. If the tab is closed or the server loses power, choosing the same file again later resumes from the last acknowledged byte, for 24 hours. The browser finds the unfinished session by destination, path and size, so this works even from another browser. The upload panel lists unfinished uploads on load, with a Discard button.
4. **Conflicts.** Before any bytes are sent, the browser asks which files already exist (`POST /api/fs/conflicts`) and asks the user what to do with each: Replace, Skip or Keep both, with "do this for all". Skipped files are never sent.
5. **Finalizing.** The last chunk finalizes the upload in the same request:
   - a journal entry is written first (see [Surviving power cuts](#surviving-power-cuts));
   - with Replace, the existing file (never a folder) goes to Trash;
   - the final name is reserved atomically with `O_EXCL`, the finished file is renamed over that placeholder, and the folder is flushed to disk. An upload never overwrites anything: with Keep both, or if a file with the name appeared in the meantime, it becomes `name (1).ext`, Windows-style;
   - the file gets its original modification date from the browser;
   - the index is updated and a `PROCESS_FILE` job is queued;
   - the request returns immediately. "Uploaded" means every byte is stored and verified.

A file only appears in `/media` once it's complete. The scanner never looks inside `.tmp-upload/`, and abandoned sessions are cleaned up after 24 hours (or right away from the upload panel or Settings → Storage).

### Uploads from the apps

The [apps](APPS.md) use a second mode of the same protocol, `mode: "chunks"`, built for long, resumable transfers:

- Chunks are numbered (`PUT …?chunk=N`) and may arrive out of order and several at once. Each is written at its own position in the `.partial` file, checked against its SHA-256 (required here), flushed, then marked in a per-session bitmap with one atomic `UPDATE … set_bit()`, so parallel chunks never lose each other's marks. A failed chunk is simply sent again; nothing is truncated.
- `GET /api/upload/sessions/:id` lists the chunks still missing. That's how an app resumes after days, a reboot or a server restart: the server is the source of truth, the app doesn't need to remember what it sent.
- "Out of order" is bounded by a write window (`LOOM_UPLOAD_WINDOW_MB`, default 512 MB past the first missing chunk). On drives without sparse files (exFAT) a far-ahead write makes the kernel zero-fill the gap on the spot, which could mean gigabytes of extra writes and requests that time out.
- Finishing (`POST …/complete`) runs the same finalize as the browser's last chunk. It can be repeated safely: the result is kept for a day and returned again, so a lost response never turns into a duplicate `name (1).ext`.
- A retried create with the same `clientRef` returns the same session. Apps pick their chunk size (1 to 95 MB) and their sessions stay resumable for 7 days (`LOOM_UPLOAD_RESUME_DAYS`).
- In-flight chunks are capped per upload, per user and in total, to keep the server's memory and disk queue bounded.
- Browsers and apps only list and clean up their own unfinished uploads: "Discard" in the browser never removes a paused app upload.

## Devices and the apps

The apps show Loom's own web UI in a window and add a transfer engine and OS integration around it. On the server:

- **Device tokens.** An app calls the API with `Authorization: Bearer loomd_…`. Only the token's SHA-256 is stored (`devices`). The app generates the token itself and sends only the hash while pairing, so no token ever crosses the wire. Lookups are cached for 15 seconds; removing a device (Devices page, password reset, deleting the user) cuts it off within that time and cascades to its web session and unfinished uploads.
- **Pairing**, valid 10 minutes, single use (`device_pairings`): either the app asks and the user approves on `/pair/<id>` after checking a six-digit code shown on both sides, or the user creates a one-time code on the Devices page (shown as a QR code) and the app redeems it. Pairing endpoints are rate-limited.
- **Signing the app's window in.** The app asks for a one-time link (`POST /api/devices/web-login`); opening it sets a normal session cookie tied to the device and redirects into Loom. Links from other sites are refused.
- **Limits of a device token.** It can't do Owner administration, manage devices, create pairing codes or share links; those need a browser sign-in, so a lost device can't mint more access.
- **`GET /api/client/info`** gives apps the version, a stable instance id, capabilities and upload limits; signed-in apps also get the LAN address and its certificate.
- **The page bridge.** When Loom runs inside an app, the app defines `window.LoomApp` before the page loads (`web/lib/client/native.ts` is the page's side), listing its capabilities (`uploads.picker`, `uploads.files`, `uploads.dropped`, `downloads`, `downloads.zip`, `transfers`, `settings`). Picked files go to the app after the usual conflict question; dropped files and folders go as they are (the app walks folders and asks about conflicts itself); downloads go to its download manager; its progress shows as a pill and its Transfers and settings are in the sidebar. The page can only hand over files the user picked or dropped, never name a local path. Messages are JSON strings; each request carries an id and the app answers with a `loomapp:ack` event, and when it doesn't answer within a few seconds the page does the job itself (its own file picker, the browser's download) rather than doing nothing. The app also sends `loomapp:transfers` (progress), `loomapp:toast` (messages) and `loomapp:navigate`. On Windows the bridge is WebView2's message channel, checked against the server's origin; on Android it's a WebView message listener (`addWebMessageListener`) and a document-start script, both limited to the server's origin and the top frame. The page gets no other access to the app.
- **The Android app** (`clients/android`) has the same parts as the Windows one: `engine/` is a Kotlin port of the Rust engine (same protocol, queue schema and behaviour, plain JVM, tested against a real Loom), `app/` is the Android app (Compose screens, the WebView, Share, a user-initiated transfer job on Android 14+ or a foreground service before that to keep transfers going). Picked files are read through their content URIs with persisted access, so uploads resume after a restart; shared and dropped files are copied into the app first. Downloads collect in the app's storage and are then saved to `Download/Loom` through MediaStore.
- **App updates** come from GitHub Releases: release workflows publish signed packages and refresh small manifests (`windows.json`, `android.json`) in a rolling `updates` release that installed apps check. The same release holds the newest apps under fixed names (`Loom-Windows-Setup.exe`, `Loom-Android.apk`), which the Devices page links to. Windows updates are signed with the Tauri updater key; Android ones carry their SHA-256 in `android.json` and must be signed with the same key as the installed app. The server isn't involved.

### LAN access

Optional (`./scripts/lan.sh enable`): a small Caddy (`loom-lan`, compose profile `lan`) serves Loom over HTTPS on the local network, with certificates from a private certificate authority the script creates once outside the media folder. loom-web only reads the authority's public certificate, from a read-only volume, and hands it to signed-in apps over the normal address; the apps trust it for the LAN address only, after checking it answers with the same instance id. The LAN listener only passes requests with a device token, marks them (`X-Loom-Via: lan`) so loom-web refuses cookies there, and replaces client-supplied address headers.

## Live updates

Whenever the index changes, the web app or the scanner publishes a small event on the Postgres channel `loom_events`, saying which folders changed and optionally which files. Examples: an upload finishing, a thumbnail becoming ready, another user renaming something. An upload that creates folders on its way (uploading a folder) also announces each new folder to the folder it appears in, so it shows up there without a refresh. Pages refresh at most every 1.5 seconds while a long stream of changes arrives.

The web process keeps one listening connection and forwards events to every open tab through `/api/events` (Server-Sent Events), filtered by each user's permissions. Pages reload only the folder that changed, without a spinner. If a proxy buffers or blocks the stream, pages fall back to light polling while thumbnails are still being generated.

When the stream drops for more than a few seconds, pages show a "reconnecting" bar and ask `/api/health` every few seconds until Loom answers. `/api/health` includes a build id (a hash of the web app's source, set in `next.config.ts`); if it differs from the one the page was built with, Loom was updated in the meantime and the page reloads itself, unless uploads from that page are still running.

## Deduplicating by content

If the same file sits at 10 different paths (a common result of years of copying things around), Loom keeps one thumbnail, one preview and one video cache for it, not 10.

This works via a `ContentIdentity` record keyed by size plus a **fast hash**: SHA-256 of the first 1 MB and the last 1 MB of the file. That's a reliable identity for caching purposes and takes milliseconds even on a 50 GB video. It's not a proof that every byte matches.

- The fast hash is computed lazily, the first time the file is read for another reason, and then saved. Loom's own copies inherit the identity without re-hashing.
- Each `FileNode` (one per path) points at a shared `ContentIdentity`. Thumbnails, previews, video caches and media metadata hang off the identity, not off any one path.
- Each cache entry has a `profileVersion`, so changing the generation settings (like the v2 EXIF rotation) never reuses old output by mistake.
- Identities that no file points to any more are deleted at the end of a rescan, together with their cache files.

## Video streaming

| Kind of video | How it's served |
|---|---|
| Browser-playable (most H.264 MP4s and WebMs) | Straight from disk with HTTP range requests. No conversion. |
| Everything else (HEVC, 10-bit, MOV, MKV, AVI, old MPEG, AC3/DTS audio…) | On-demand HLS, converted by FFmpeg as it's watched |

For on-demand HLS, Loom builds a full-length playlist right away from the probed duration, so the player shows the whole timeline immediately. FFmpeg only converts the part being watched, in 6-second segments:

- a seek far ahead starts a new region instead of waiting for the old one to catch up;
- viewers of the same region share one FFmpeg process;
- regions nobody is requesting stop after 20 seconds, but finished segments stay;
- at most `LOOM_MAX_TRANSCODES` conversions run at once (default 2).

The output is 8-bit H.264, at most 1080p, with stereo AAC, which plays in every browser. Segments are written to a temp file and renamed, so the player never gets a half-written one. Caches live in `/cache/videos/<content id>/<profile>/`, are shared by identical files, and survive restarts. The HLS engine is `web/lib/hls-manager.ts`.

## Trash

Deletes aren't immediate. A deleted item is moved into `/media/.LoomTrash/` (which the scanner skips), and its `FileNode` gets `inTrash = true` while keeping everything needed to restore it. Items are purged 15 days after deletion by the hourly housekeeping.

- Restoring to a path that something else now occupies stops with a conflict. The user then chooses **Keep both** (restored under a free name) or **Replace** (the current item goes to Trash first). Several items with conflicts are each asked about.
- If the original folder no longer exists, it's recreated. Items can also be restored to a different folder.
- Family users see and restore only what they deleted; the Owner sees everything.
- Replacing a file and saving a text edit also put the old version in Trash, so nothing Loom does is irreversible for 15 days.

## Changing files safely

Every change Loom makes to your files goes through `web/lib/file-ops.ts`: rename, move, copy, trash, restore and new folder.

- Names and paths are validated (`web/lib/fs-guard.ts`), and permission checks run on the normalized path, so tricks like `Allowed/../Private` or a name containing `/` are rejected.
- Nothing is overwritten in place. "Replace" always moves the existing item to Trash first.
- The filesystem change happens first. If updating the index then fails, the change is rolled back, so disk and database agree.
- Paths are locked hierarchically for the duration of an operation.
- A folder's descendants are updated with one SQL statement, so moving a folder with 50,000 files is instant.
- Permission rules and Trash restore locations follow a folder when it's renamed or moved. (Sidebar pins follow too; the browser keeps them up to date.)
- Case-only renames (`photo.jpg` → `Photo.jpg`) work on case-insensitive drives like exFAT.

## Copy, move and name conflicts

Copying and moving work like Windows Explorer (`web/lib/transfer.ts`):

1. **Dry run.** `POST /api/fs/conflicts` walks the source and lists every file that already exists at the destination, with both sizes and dates. Same-named folders aren't conflicts: they merge.
2. **Decisions.** The browser asks about each file: Replace (the existing one goes to Trash), Skip, or Keep both (`name (1).ext`). "Do this for the other N conflicts" answers the rest. A file and a folder with the same name can't replace each other, so only Keep both or Skip applies there.
3. **Run.** The move or copy runs with those decisions. Merging a folder by moving leaves the source folder behind only if some files in it were skipped.

Moves are instant renames. Copies run as background jobs (`web/lib/copy-jobs.ts`, tracked in the `background_jobs` table): the request returns immediately, progress arrives as live events (and can be polled at `GET /api/fs/jobs/:id`), and a copy can be cancelled. This keeps big copies from hitting proxy time limits (Cloudflare's is 100 seconds).

## Surviving power cuts

Every multi-step change is written so that an interruption at any point leaves either the old state or the new one, never something half-done:

- **Copies** are written to a hidden `.loom-tmp-…` name next to the destination and renamed into place only when every byte is on disk, without ever overwriting anything (a hard link that fails if the name is taken, or a check-and-rename under the path lock on drives without hard links, like exFAT).
- **Text edits** are written to a temp file, flushed, then renamed over the original; the previous version is already in Trash.
- **Uploads** only appear once finished (see [Uploads](#uploads)).

Before each of these, Loom writes a small journal entry to `.tmp-upload/journal/` and flushes it (`web/lib/fs-journal.ts`). Each web process has a random boot ID, so when Loom starts (`web/instrumentation.ts` → `web/lib/recovery.ts`), any entry from an earlier process belongs to an operation that died with it:

- a temp file from an interrupted copy or edit is deleted;
- an upload that was being moved into place is either finished (the file is complete, so it's indexed) or rolled back (its empty name placeholder is removed; the upload can still be resumed);
- copy jobs that were running are marked as interrupted. Files they had already copied are complete and stay.

As a backstop, a full rescan deletes Loom temp files older than an hour that no journal entry refers to, and never indexes them. Recovery only ever deletes files Loom itself created. `docker compose logs loom-web` shows a `[recovery]` line describing what was cleaned up.

## Editing text files

The viewer can edit text, code and Markdown files up to 5 MB (`web/app/api/files/content/route.ts`).

- **Conflict check.** When saving, the browser sends the version (size and mtime) the file had when it was opened. If the file changed on disk since then, the server answers with a conflict instead of overwriting, and the user decides.
- **Previous version kept.** Before writing, the current contents are copied into `.LoomTrash/` as a "previous version" Trash item, so an edit can be undone for 15 days.
- **Atomic write.** The new contents go to a temp file in the same folder, are flushed to disk, and renamed over the original.
- **Safe rendering.** Markdown is rendered without raw HTML, so a Markdown file can't run scripts.

## Downloads

Single files stream straight from disk with range support, conditional requests (ETag/Last-Modified) and correct non-ASCII filenames (`web/lib/send-file.ts`). Several items, or a folder, are streamed as one ZIP generated on the fly (`web/lib/zip.ts`): no temp files, no size limit, and archives over 4 GB use ZIP64 automatically. Photos, videos and other already-compressed files are stored without recompression, so zipping a folder of videos costs almost no CPU. Permissions are checked for every entry.

## Share links

People without an account can open a file or folder through a link like `https://your-loom/s/<token>`. Sharing is off until the Owner enables it in Settings → Sharing, and turning it off disables every link at once. The logic is in `web/lib/shares.ts`.

- **Tokens** are 32 random bytes. The database stores their SHA-256 for lookup, plus an AES-256-GCM encrypted copy (key derived from `BETTER_AUTH_SECRET` with HKDF) so the creator can copy the link again later. Changing the secret doesn't break existing links; they just can't be shown again.
- **Options:** an expiry, a password (bcrypt), and a "view only" mode that refuses downloads and ZIPs.
- **Password-protected links.** Unlocking one sets an HMAC-signed cookie that lasts 12 hours and covers only that link. Wrong guesses are rate-limited to 10 per 10 minutes per visitor.
- **Checks on every request:** the link isn't revoked or expired, the item isn't in Trash, sharing is still on, and the person who created the link can still read everything in it. A Family user who loses access to a folder therefore can't keep a link to it alive.
- **Confinement.** Paths inside a shared folder are resolved relative to the shared item, so a link can never reach anything outside it.
- **Links follow the item.** A link points at the `FileNode`, so it survives renames and moves, pauses while the item is in Trash, and is deleted along with it.
- **Who can create links.** Any signed-in user, for items they can fully access (`canAccessTree`). The Owner can see and delete everyone's links.
- **Logging.** Creating, changing and deleting links is audit-logged, and each link counts how often it was opened.

## Permissions

There are two roles:

| Role | Access |
|---|---|
| Owner | Everything, always. Bypasses all permission rules. The last Owner can't be demoted or deleted. |
| Family | Filtered by path rules. With no rules at all, a Family user can see everything; the Owner adds rules to restrict them. |

A rule is a path plus allow or deny, and **the deepest rule that matches a path wins**, so rules can be stacked. A rule on `/` is the root rule and covers everything, so "deny `/`, allow `Photos`" limits someone to one folder.

The evaluator (`web/lib/acl.ts`) loads a user's rules once per request and answers three questions:

| Check | Meaning |
|---|---|
| `canAccess(p)` | May the user read or change `p` itself? |
| `canTraverse(p)` | May the user see `p` in listings and open it to reach an allowed descendant? A denied folder containing an allowed sub-folder is traversable but not accessible. |
| `canAccessTree(p)` | May the user act on `p` and everything under it? Required for move, rename, trash, copy, download and share of a folder, so a denied sub-folder can never be carried along by an operation on its parent. |

Nobody can sign up on their own: the first account comes from the setup page, and after that only the Owner adds users. Roles can only be changed by the Owner through Settings → Users; the auth library's own user-update endpoints can't set them. Every change anywhere in the app goes in the audit log, which is kept for 180 days (`LOOM_AUDIT_RETENTION_DAYS`).

## Serving files safely

Files are served from Loom's own origin, so a malicious file must not be able to run code in a viewer's browser with their session:

- types a browser could execute (HTML, SVG, XML, JavaScript) are downloaded instead of displayed, or shown as plain text;
- every response carries `X-Content-Type-Options: nosniff`;
- anything shown inline gets a sandboxing Content-Security-Policy;
- thumbnails and previews are only served to users allowed to see at least one file with that content (`web/lib/cache-access.ts`);
- the app itself sends `frame-ancestors`, `Referrer-Policy` and `Permissions-Policy` headers on every page.

## Schema and migrations

The schema lives in `web/prisma/schema.prisma`. A byte-identical copy lives in `scanner/prisma/schema.prisma` so the scanner's Docker image can generate a matching Prisma client at build time; `scripts/sync-schema.sh` checks that the two match (run it with `--fix` if you edit one by hand), and CI enforces it.

Migrations live in `web/prisma/migrations/` and are applied automatically by loom-web's entrypoint on every start (`prisma migrate deploy`). There's no separate migration step. Migrations are additive: they never drop a table or a column that holds data, so an older version of Loom still runs on a newer database (which is what makes `update.sh --rollback` safe). Two indexes Prisma can't express live only in migration SQL; see the comment on `FileNode` in the schema.
