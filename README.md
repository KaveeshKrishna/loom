# Loom

Loom is a self-hosted file manager for a server or NAS. You point it at a folder of files you already have (photos, videos, documents, whatever) and it gives you a web app to browse, search, and stream them from anywhere.

The whole idea is that your files don't move. Loom reads the folder you give it and shows you what's there. It doesn't copy your files into its own storage and it doesn't rearrange them. If you stop using Loom one day, your files are exactly where they were.

Try the [live demo](https://loomdemo.kaveeshkrishna.in). It's a fake version with no backend and no real data, any username and password works. The code for it is in the [loom-demo](loom-demo/) folder.

## What it does

- Browse your files in a grid or a list that stays fast with tens of thousands of files in a folder. Sort by name, date, size or type, filter by kind (photos, videos, audio, documents, folders), and open a details panel with EXIF (camera, date taken, location), video codec and resolution, and recent activity.
- Upload anything, any size. Drag files or whole folders onto the page, or use the New button. Big videos are sent in verified chunks, so they work behind Cloudflare and other proxies, resume after a dropped connection, a closed tab or a power cut, and never fill the server's memory. Nothing half-finished ever shows up in your folders. An upload counts as done the moment its last byte is safely stored. Thumbnails and previews appear a few seconds later, on their own.
- Manage files like a desktop app:
  - Rename inline (F2), make folders and text files.
  - Cut, copy and paste, or Move to… and Copy to… with a folder picker.
  - Drag onto folders, breadcrumbs or the sidebar to move things.
  - Select many items and move, copy, star, download or delete them together.
  - Keyboard shortcuts throughout.
  - Undo for moves, renames and deletes.
  - If a name is already taken, Loom asks, like Windows: replace, skip or keep both, with "do this for all". Folders merge. Replace never destroys anything, because the old item goes to Trash.
- Download single files directly, or any selection of files and folders as one ZIP, streamed on the fly with no size limit.
- Share links. Send anyone a link to a file or folder, no account needed. Links can have an expiry, a password, and a view-only mode, and you can revoke them at any time. Sharing is off until the Owner turns it on.
- View and edit:
  - Full screen viewer with a filmstrip: photos with zoom, pan and slideshow; videos; audio with auto-advance; PDFs.
  - Text, code and Markdown with syntax highlighting.
  - Edit text files right in the browser. Saving is conflict-safe, and the previous version is kept in Trash.
- Video streaming. Videos the browser can play are streamed as-is. Everything else (HEVC, 10-bit, MOV, MKV, AVI, AC3 audio…) is converted while you watch, only the part you're watching. You can seek anywhere instantly.
- Live updates. Folders refresh by themselves when uploads finish, thumbnails are ready, or someone else changes something.
- Deduplication. If the same file exists in more than one place, Loom only makes one thumbnail, preview and video cache for it.
- Trash. Deleted files go to Trash for 15 days. You can restore to the original place or somewhere else, and conflicts are handled instead of overwritten.
- Health checks. Broken or unsupported files are flagged on their own page, so you don't confuse them with missing ones.
- More than one user. There's an Owner role and a Family role, and Family users can be limited to certain folders. Nobody can sign up on their own.
- Audit log. Every change is logged.
- Storage. See how full your drive is and what your library is made of.
- Leaves your drive alone. Loom doesn't watch the disk and doesn't scan on startup, so drives can spin down and stay down until you ask for a rescan.

## What you need

A Linux server, or anything that can run Docker, is the point. A home server, NAS, or VPS all work. You'll need Docker Engine and Docker Compose v2, the folder of files you want to manage, and some free space somewhere else for the thumbnail/preview/video cache (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why). If you want to reach Loom from outside your home network you'll also want a reverse proxy like Caddy or nginx, or a tunnel like Cloudflare Tunnel, see [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md).

## Install

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
./scripts/install.sh
```

The installer asks where your files are, makes the secrets, builds the containers, and starts everything. When it finishes, open the URL it prints and make your Owner account. Loom notices it's a fresh install and shows a setup page instead of a login form.

If you'd rather do it by hand, see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Config

Everything lives in one .env file in the repo root, which the installer makes from .env.example. The main things in there are LOOM_MEDIA_PATH (where your files are on the host), LOOM_CACHE_PATH (where the cache goes), LOOM_BIND and LOOM_PORT (local address and port for the web app), POSTGRES_PASSWORD and BETTER_AUTH_SECRET (both generated automatically by the installer), and BETTER_AUTH_URL / TRUSTED_ORIGINS (the public URL you'll use to reach Loom). Full list in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Running it

```bash
docker compose ps                       # what's running
docker compose logs -f loom-web         # web app logs
docker compose logs -f loom-scanner     # scanner logs
./scripts/backup-db.sh                  # back up the database
./scripts/uninstall.sh                  # stop and remove the containers
```

Files you upload through Loom are indexed and processed automatically. Files you add or change outside Loom (straight on the drive, over SMB, etc.) show up after a rescan. Rescans are manual on purpose: as the Owner, go to Settings, then Scanner, then Scan Now. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains why.

## Updating

```bash
./scripts/update.sh
```

It shows what's new and asks first. Then it backs up the database (and checks the backup), downloads the new version, builds it while the old one keeps running, restarts, and waits until everything is healthy. If anything goes wrong, `./scripts/update.sh --rollback` takes you back. Your media folder is never touched by installing, updating or uninstalling. `./scripts/update.sh --check` just tells you whether there's a new version. Details, and notes for specific versions, are in [docs/UPGRADING.md](docs/UPGRADING.md) and [CHANGELOG.md](CHANGELOG.md).

## Docs

[Using Loom](docs/USING.md) (features and keyboard shortcuts), [Installation](docs/INSTALLATION.md), [Configuration](docs/CONFIGURATION.md), [How Loom works](docs/ARCHITECTURE.md), [Reverse proxy setup](docs/REVERSE-PROXY.md), [Upgrading](docs/UPGRADING.md), and [Troubleshooting](docs/TROUBLESHOOTING.md) are all in the docs folder.

## Rules Loom follows

These are things the code will not do, on purpose. It never deletes or overwrites your original files: deletes, replaces and text edits all keep the old version in a Trash you can undo. It never moves or renames your existing folders on its own, and it never reorganizes your folder structure. Thumbnails, previews, and metadata only go in the separate cache folder, never next to your files. Your filesystem is the truth, the database is just an index of it, and if they disagree the filesystem is right. Loom fits your folders, your folders don't have to fit Loom.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security bugs, read [SECURITY.md](SECURITY.md) first.

## License

Loom uses the [PolyForm Noncommercial License 1.0.0](LICENSE). You can use, change, self-host, and share it for anything noncommercial, personal use, home labs, nonprofits, school, research. Charging money for Loom, or for a service built on it, needs a separate agreement with me. That makes Loom source-available, not OSI open source, and the license file has the exact wording.
