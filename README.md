# Loom

Loom is a self-hosted file manager for a server or NAS. You point it at a folder of files you already have (photos, videos, documents, anything) and it gives you a web app to browse, search, and stream them from anywhere.

The main idea: your files don't move. Loom reads the folder you give it and shows you what's there. It doesn't copy your files into its own storage and it doesn't rearrange them. If you stop using Loom, your files are exactly where they were.

[Try the live demo](https://loomdemo.kaveeshkrishna.in). It's a fake version with no backend and no real data. Any username and password works. The code for it is in [loom-demo/](loom-demo/).

## What it does

- Browse files in a grid or a list. Upload by drag and drop, cut/copy/paste, rename, make folders, right-click menus. Works on touch screens too.
- Full-screen photo and video viewer with a filmstrip of the other files in the folder and keyboard shortcuts.
- Video streaming. Videos the browser can already play are served as-is. Formats it can't play (HEVC, MOV, MKV, AVI, and so on) get converted while you watch, one piece at a time, so playback starts right away instead of waiting for the whole file to convert.
- If the same file exists in more than one place, Loom makes only one thumbnail, preview, and video cache for it, and only when something actually needs it.
- Deleted files go to a trash folder for 15 days before they're really gone. Restoring checks for conflicts first.
- Broken or unsupported files get flagged on their own page so you don't mix them up with missing files.
- More than one user. There's an Owner role and a Family role. Family users can be limited to certain folders.
- Every change (move, delete, restore, rename, permission change) is written to a log.
- Loom doesn't watch the disk and doesn't scan on startup. Drives can spin down and stay down until you ask for a rescan.

## What you need

- A Linux server, or anything that runs Docker. A home server, NAS, or VPS is the point.
- Docker Engine and Docker Compose v2.
- The folder of files you want to manage, plus some free space somewhere else for the thumbnail/preview/video cache. See [How Loom works](docs/ARCHITECTURE.md).
- To reach Loom from outside your home network, a reverse proxy (Caddy, nginx, Traefik) or a tunnel (Cloudflare Tunnel, Tailscale). See [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md).

## Install

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
./scripts/install.sh
```

The installer asks where your files are, makes the secrets, builds the containers, and starts everything. When it finishes, open the URL it prints and make your Owner account. Loom notices it's a fresh install and shows a setup page instead of a login form.

To set it up yourself, see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Config

Everything is in one `.env` file in the repo root. The installer makes it from `.env.example`. Full list: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Variable | What it's for |
|---|---|
| `LOOM_MEDIA_PATH` | Where your files are on the host |
| `LOOM_CACHE_PATH` | Where the thumbnail/preview/video cache goes |
| `LOOM_BIND` / `LOOM_PORT` | Local address and port for the web app |
| `POSTGRES_PASSWORD` | Database password (installer generates it) |
| `BETTER_AUTH_SECRET` | Secret for signing login sessions (installer generates it) |
| `BETTER_AUTH_URL` / `TRUSTED_ORIGINS` | The public URL you'll use to reach Loom |

## Running it

```bash
docker compose ps                       # what's running
docker compose logs -f loom-web         # web app logs
docker compose logs -f loom-scanner     # scanner logs
./scripts/update.sh                     # pull, rebuild, migrate, restart
./scripts/backup-db.sh                  # back up the database
./scripts/uninstall.sh                  # stop and remove the containers
```

Rescans are manual on purpose. As the Owner, go to Settings, then Scanner, then Scan Now. [How Loom works](docs/ARCHITECTURE.md) explains why.

## Docs

- [Installation](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [How Loom works](docs/ARCHITECTURE.md)
- [Reverse proxy](docs/REVERSE-PROXY.md)
- [Upgrading](docs/UPGRADING.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Rules Loom follows

These are things the code will not do, on purpose:

1. It never deletes your original files. Deletes go to a trash you can undo.
2. It never moves or renames your existing folders on its own.
3. It never reorganizes your folder structure.
4. Thumbnails, previews, and metadata only go in the separate cache folder, never next to your files.
5. Your filesystem is the truth. The database is just an index. If they disagree, the filesystem is right.
6. Loom fits your folders. Your folders don't have to fit Loom.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security bugs, read [SECURITY.md](SECURITY.md) first.

## License

Loom uses the [PolyForm Noncommercial License 1.0.0](LICENSE). You can use, change, self-host, and share it for anything noncommercial: personal use, home labs, nonprofits, school, research. Charging money for Loom, or for a service built on it, needs a separate agreement with me. That makes Loom source-available, not OSI open source. The license has the exact wording.
