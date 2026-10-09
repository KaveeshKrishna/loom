<p align="center"><img src="brand/loom.svg" width="96" height="96" alt=""></p>

# Loom

Loom is a self-hosted file manager for your own server or NAS. Point it at a folder of files you already have (photos, videos, music, documents, anything) and it gives you a fast web app to browse, search, stream, share, and organize them from anywhere.

It is built around one rule: **your files stay exactly where they are, organized exactly how you left them.** Loom reads the folder you give it and shows you what's there. It never imports your files into its own storage, never renames or rearranges them, and never overwrites them. If you stop using Loom one day, your files are exactly where they were.

**[Try the live demo](https://loomdemo.kaveeshkrishna.in).** It's a fully fabricated build with no backend and no real data. Any username and password works. See [loom-demo/](loom-demo/) for how it's built.

## Features

**Browsing**
- Grid and list views that stay fast with tens of thousands of files in one folder.
- Sort by name, date, size or type, and filter by kind (photos, videos, audio, documents, folders).
- Library-wide views for Photos, Videos, Audio, Documents, Starred and Recent.
- Search the current folder or the whole library.
- A details panel with EXIF data (camera, lens, date taken, GPS location), video resolution and codecs, file health, and recent activity.
- Live updates: folders refresh on their own when an upload finishes, a thumbnail is ready, or someone else changes something.

**Uploading**
- Drag and drop files or whole folders, or use the New button.
- Any size. Files are sent in verified 32 MB chunks straight to disk, so a 50 GB video uses as little server memory as a photo, and uploads work behind Cloudflare and other proxies with request size limits.
- Resumable after a dropped connection, a closed tab, or a power cut. Nothing half-finished ever appears in your folders.
- An upload counts as done the moment its last byte is safely stored. Thumbnails and previews are generated in the background a few seconds later.

**Apps**
- [Loom for Windows and Loom for Android](docs/APPS.md) (phones and tablets): Loom in an app, with uploads and downloads that keep going in the background, survive restarts, and go straight to your server over your home network. "Upload to Loom" in File Explorer, Share › Loom on Android. Both update themselves.
- Pair an app by approving it in Loom or scanning a code; remove it any time under Devices.

**Organizing**
- Rename inline (F2), create folders and text files, cut/copy/paste, Move to… and Copy to… with a folder picker.
- Drag items onto folders, breadcrumbs or the sidebar to move them.
- Multi-select with bulk move, copy, star, download and delete.
- Undo for moves, renames and deletes, plus keyboard shortcuts throughout.
- Windows-style name conflicts: Replace, Skip or Keep both, with "do this for all". Same-named folders merge. Replace never destroys anything, the old item goes to Trash.
- Big copies run in the background with progress and Cancel.

**Viewing and editing**
- Full-screen viewer with a filmstrip: photos (zoom, pan, slideshow), video, audio (auto-advance), and PDF.
- Text, code (syntax highlighted) and Markdown (rendered).
- Edit text files in the browser. Saving detects changes made on disk in the meantime, and the previous version is kept in Trash.
- Video streaming for any format. Browser-compatible videos play directly. Everything else (HEVC, 10-bit, MOV, MKV, AVI, AC3 audio…) is converted on the fly, only the part you are watching, and you can seek anywhere instantly.
- Download any selection of files and folders as one ZIP, streamed with no size limit.

**Sharing and users**
- Share links to a file or folder for people without an account, with optional password, expiry and view-only mode. Revocable at any time. Off until the Owner turns it on.
- Multiple users with two roles, Owner and Family. Family users can be restricted to specific folders. Nobody can sign up on their own.
- An audit log of every change.

**Safety**
- Deleted files go to Trash for 15 days. Restore to the original location or somewhere else, with conflicts handled rather than overwritten.
- Crash safety: copies, edits and uploads are written to hidden temp files and only put in place when complete. A journal lets Loom finish or undo interrupted operations on the next start.
- File health: corrupt and unsupported files are flagged on their own page, so you don't confuse them with missing ones.
- Content deduplication: identical files share one thumbnail, preview and video cache.
- Idle by default: no filesystem watcher, no scan on startup, no hashing during a rescan. Drives can spin down and stay down.

## Requirements

- A Linux server, or any machine that can run Docker. A home server, NAS or VPS is the intended use.
- [Docker Engine](https://docs.docker.com/engine/install/) and [Docker Compose v2](https://docs.docker.com/compose/install/).
- The folder of files you want to manage, plus free space on a separate path for the thumbnail, preview and video cache (see [How Loom works](docs/ARCHITECTURE.md)).
- `git`, `openssl` and `curl` on the host (the installer uses them).
- To reach Loom from outside your home network: a reverse proxy (Caddy, nginx, Traefik) or a tunnel (Cloudflare Tunnel, Tailscale). See [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md).

## Quick start

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
./scripts/install.sh
```

The installer asks where your files live and where the cache should go, generates secrets, builds the containers, starts everything and waits until it's healthy. When it's done, open the URL it prints and create your Owner account. A fresh install shows a setup page instead of a login form automatically.

To do it by hand, or to see every option, read [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Configuration

All configuration lives in a single `.env` file in the repo root, generated from `.env.example` by the installer. The essentials:

| Variable | Purpose |
|---|---|
| `LOOM_MEDIA_PATH` | Host path to the folder of files Loom manages |
| `LOOM_CACHE_PATH` | Host path for thumbnails, previews and the video cache (must not be inside the media folder) |
| `LOOM_BIND` / `LOOM_PORT` | Local address and port for the web app (default `127.0.0.1:8085`) |
| `POSTGRES_PASSWORD` | Database password (generated by the installer) |
| `BETTER_AUTH_SECRET` | Session and share-link signing secret (generated by the installer, required) |
| `BETTER_AUTH_URL` / `TRUSTED_ORIGINS` | The public URL you'll reach Loom at, also used for share links |

Upload chunk size, worker concurrency, transcode limits and the rest are optional. Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Day-to-day commands

```bash
docker compose ps                       # service status
docker compose logs -f loom-web         # web app logs
docker compose logs -f loom-scanner     # scanner logs
./scripts/update.sh                     # update to the latest version (backs up first)
./scripts/update.sh --check             # is there a new version?
./scripts/update.sh --rollback          # go back to the version before the last update
./scripts/backup-db.sh                  # back up the database
./scripts/restore-db.sh <backup>        # restore a database backup
./scripts/uninstall.sh                  # stop and remove the containers
```

Files you upload or change through Loom are indexed and processed automatically. Files added or changed outside Loom (directly on the drive, over SMB, etc.) appear after a rescan, which is manual by design: as the Owner, go to **Settings → Scanner → Scan Now**. [How Loom works](docs/ARCHITECTURE.md#keeping-the-drive-idle) explains why.

## Updating

```bash
./scripts/update.sh
```

It shows the new version and its changes and asks before doing anything. Then it backs up the database (and verifies the backup), fast-forwards the code, builds the new images while the old version keeps running, restarts, and waits until everything is healthy. If anything fails it offers to roll back. Your media folder is never touched by installing, updating or uninstalling. See [docs/UPGRADING.md](docs/UPGRADING.md) and [CHANGELOG.md](CHANGELOG.md).

## Documentation

| Document | What's in it |
|---|---|
| [Using Loom](docs/USING.md) | A tour of the features, keyboard shortcuts, sharing, Trash, Owner settings |
| [The apps](docs/APPS.md) | Loom for Windows and Android: install, pairing, transfers, File Explorer, Share, updates; LAN access |
| [Installation](docs/INSTALLATION.md) | The installer, manual setup, file permissions, first login |
| [Configuration](docs/CONFIGURATION.md) | Every environment variable |
| [How Loom works](docs/ARCHITECTURE.md) | Architecture, background jobs, uploads, crash safety, share links, security |
| [Reverse proxy](docs/REVERSE-PROXY.md) | Caddy, nginx, Traefik and Cloudflare Tunnel setups |
| [Upgrading](docs/UPGRADING.md) | Updates, rollback, backups, version-specific notes |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common problems and their fixes |
| [Changelog](CHANGELOG.md) | What changed in each version |

## Design rules

These are invariants Loom is built around, not aspirations:

1. Loom never deletes or overwrites your original files. Deletes, replaces and text edits all keep the old version in a recoverable Trash.
2. Loom never moves or renames your existing folders on its own.
3. Loom never reorganizes your folder structure.
4. Thumbnails, previews and metadata are written only to the separate cache folder, never next to your files.
5. Your filesystem is the source of truth. The database is only an index of it, and if they disagree, the filesystem wins.
6. Loom adapts to your folder structure. Your files never have to adapt to Loom.

## Contributing

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

Loom is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You're free to use, modify, self-host and share Loom for any **noncommercial** purpose: personal use, home labs, nonprofits, education, research. Commercial use (offering Loom, or a service built on it, for a fee) requires a separate agreement with the author. This makes Loom **source-available**, not OSI-approved open source. See the license for the exact terms.
