# Changelog

What changed in each version of Loom, newest first. Update with `./scripts/update.sh`, see [docs/UPGRADING.md](docs/UPGRADING.md).

## 2.0.0

A big release: fast uploads, a new file browser, editing, share links, and a safe updater. Your files and settings carry over. The database is backed up and upgraded automatically.

### Before you update

- Run `./scripts/update.sh` as usual. On an install from before 2.0 your update.sh is the old one; that's fine, it handles this update. Note your current commit first (`git rev-parse --short HEAD`) in case you want to go back by hand. See "Upgrading to 2.0" in docs/UPGRADING.md.
- BETTER_AUTH_SECRET must be a real value. loom-web won't start if it's empty or the example value.
- Public sign-up is closed. The Owner adds accounts in Settings, Users.
- If you use a reverse proxy, allow request bodies of at least 32 MB and don't buffer /api/events (docs/REVERSE-PROXY.md).
- The first start runs a database migration that can take a few minutes on a big library.

### After you update

- Run Scan Now once (Settings, Scanner) to regenerate thumbnails with correct rotation for sideways photos. Otherwise it happens gradually as you browse.
- Share links are off until you turn them on in Settings, Sharing.

### Uploads

- Uploads go in 32 MB chunks straight to disk, so the server's memory stays flat whatever the file size, and they work behind Cloudflare's 100 MB limit.
- Every chunk is checked with SHA-256 and flushed to disk before it counts. A damaged chunk is retried automatically.
- An upload is marked done as soon as its last byte is stored. Thumbnails, previews and video info are made in the background and appear on their own.
- Uploads resume after a dropped connection, and after closing the tab (pick the same file again).
- Uploaded files keep their original modified date. Name clashes never overwrite; the new file gets a numbered name.
- Folder uploads by drag and drop, overall progress with speed and time left, retry and cancel.

### Background processing

- New uploads are processed within a second, in parallel (LOOM_WORKER_CONCURRENCY), and never wait behind a full rescan.
- The scanner never modifies your files: it reads them, and writes only into the cache, atomically.
- Photos are rotated correctly using their EXIF orientation. Camera, date taken, lens and GPS location are shown in the details panel. Videos show duration, resolution and codecs.
- Rescans are much faster on big libraries and don't rehash unchanged files.
- Interrupted jobs are picked up again after a restart.

### File browser

- Rewritten to stay fast with tens of thousands of files in one folder.
- Live updates: folders refresh by themselves when uploads finish, thumbnails are ready, or someone else changes something.
- New button, inline rename (F2), multi-select with bulk move, copy, star, download and delete, drag and drop onto folders, breadcrumbs and the sidebar, Move to… and Copy to… with a folder picker, undo, keyboard shortcuts.
- Sort by name, date, size or type, and filter by kind.
- Details panel with EXIF, video info, file health and recent activity.
- Recent and Audio pages, starred folders, pinned folders that follow renames, a storage meter.
- Name clashes ask to keep both, replace or skip. Replace moves the old item to Trash.
- Trash can restore somewhere else, and restores into folders that no longer exist.

### Viewing and editing

- Viewer for photos (zoom, pan, slideshow), video, audio (auto-advance), PDF, text, code (syntax highlighting) and Markdown (rendered).
- Edit text files in the browser. Saving detects changes made on disk meanwhile, and the previous version goes to Trash.
- Download any selection of files and folders as one ZIP, streamed with no size limit.

### Share links

- Share a file or folder with anyone, no account needed. Optional password, expiry and view-only mode. Revoke at any time.
- Off by default; the Owner decides whether Family users can share.
- Links stop working if the item is trashed, the creator loses access, or sharing is turned off.

### Video

- Converted streams are shared between copies of the same video and survive restarts.
- Seeking far ahead starts converting from there immediately.
- Converted output is 8-bit H.264 up to 1080p with stereo audio, so it plays everywhere (including 10-bit HEVC sources).
- LOOM_MAX_TRANSCODES limits how many videos are converted at once.

### Security

- Public sign-up disabled; roles can't be changed from the browser; sign-in is rate-limited; the setup page can't create a second Owner even with two requests at once.
- Fixed path traversal in folder creation, rename and upload, and a permission bypass through `..` in paths.
- Fixed permission checks on thumbnails and previews, favorites, file health, restoring other users' trash, and the root permission rule.
- Files served from Loom can't run scripts in Loom's origin (nosniff, sandboxing CSP, forced download for HTML and SVG). Security headers on every page.
- Symlinks can't be used to reach files outside the media folder.
- The last Owner can't be demoted or deleted. Changing a password signs that user out everywhere.
- A case-only rename (photo.JPG to photo.jpg) no longer risks losing the file.
- The scanner runs as an unprivileged user instead of root.

### Install and update

- `./scripts/update.sh` shows what's new, refuses to overwrite local edits, backs up and verifies the database, only fast-forwards, builds before stopping the running version, waits for health, and can `--rollback`. `--check` tells you if there's a new version.
- `./scripts/restore-db.sh` restores a backup (after backing up the current state).
- Backups are gzipped, verified, private (mode 600) and rotated (LOOM_KEEP_BACKUPS).
- The installer refuses a cache folder inside the media folder, asks before creating a missing media folder, and never changes ownership of your media.
- uninstall.sh backs up the database before deleting it.
- Password reset for a locked-out Owner: `docker compose exec loom-web node scripts/reset-password.mjs you@example.com`.
- File Health has a Check again button.
- Container logs are capped at 30 MB per service.
- /api/health reports the running version.

## 1.0.0

First public release.
