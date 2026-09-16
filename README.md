# Loom

Loom is a self-hosted file manager for a server or NAS. You point it at a folder of files you already have (photos, videos, documents, whatever) and it gives you a web app to browse, search, and stream them from anywhere.

The whole idea is that your files don't move. Loom reads the folder you give it and shows you what's there. It doesn't copy your files into its own storage and it doesn't rearrange them. If you stop using Loom one day, your files are exactly where they were.

Try the [live demo](https://loomdemo.kaveeshkrishna.in). It's a fake version with no backend and no real data, any username and password works. The code for it is in the [loom-demo](loom-demo/) folder.

## What it does

- Browse files in a grid or a list. Drag and drop to upload, cut/copy/paste, rename, make folders, right click menus, works on touch screens too.
- Full screen photo and video viewer with a filmstrip of the other files in the folder and keyboard shortcuts.
- Video streaming. Videos the browser can already play are served as-is. Formats it can't play (HEVC, MOV, MKV, AVI, and so on) get converted while you watch, one piece at a time, so playback starts right away instead of waiting for the whole file to convert first.
- If the same file exists in more than one place, Loom only makes one thumbnail, preview, and video cache for it, and only when something actually needs it.
- Deleted files go to a trash folder for 15 days before they're really gone. Restoring checks for conflicts first.
- Broken or unsupported files get flagged on their own page so you don't confuse them with files that are just missing.
- More than one user. There's an Owner role and a Family role, and Family users can be limited to certain folders.
- Every change (move, delete, restore, rename, permission change) gets written to a log.
- Loom doesn't watch the disk and doesn't scan on startup. Drives can spin down and stay down until you ask for a rescan.

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
./scripts/update.sh                     # pull, rebuild, migrate, restart
./scripts/backup-db.sh                  # back up the database
./scripts/uninstall.sh                  # stop and remove the containers
```

Rescans are manual on purpose. As the Owner, go to Settings, then Scanner, then Scan Now. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains why.

## Docs

[Installation](docs/INSTALLATION.md), [Configuration](docs/CONFIGURATION.md), [How Loom works](docs/ARCHITECTURE.md), [Reverse proxy setup](docs/REVERSE-PROXY.md), [Upgrading](docs/UPGRADING.md), and [Troubleshooting](docs/TROUBLESHOOTING.md) are all in the docs folder.

## Rules Loom follows

These are things the code will not do, on purpose. It never deletes your original files, deletes go to a trash you can undo. It never moves or renames your existing folders on its own, and it never reorganizes your folder structure. Thumbnails, previews, and metadata only go in the separate cache folder, never next to your files. Your filesystem is the truth, the database is just an index of it, and if they disagree the filesystem is right. Loom fits your folders, your folders don't have to fit Loom.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security bugs, read [SECURITY.md](SECURITY.md) first.

## License

Loom uses the [PolyForm Noncommercial License 1.0.0](LICENSE). You can use, change, self-host, and share it for anything noncommercial, personal use, home labs, nonprofits, school, research. Charging money for Loom, or for a service built on it, needs a separate agreement with me. That makes Loom source-available, not OSI open source, and the license file has the exact wording.
