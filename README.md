# Loom

> **Weaving your digital life together.**

Loom is a production-quality, self-hosted personal storage application for the `kkp-node` home VPS. It is a premium, permission-aware file explorer that sits on top of the Samsung T7 filesystem, preserving the user's folder organization.

---

## Architecture

| Component | Technology | Port |
|---|---|---|
| Web App | Next.js 15 (App Router) | 127.0.0.1:8085 |
| Database | PostgreSQL 17 (Docker) | internal |
| Scanner | Node.js (Docker, event-driven + reconciliation) | — |

**Storage layout:**

| Path | Purpose |
|---|---|
| `/srv/storage/personal/media` | Samsung T7 (original files — source of truth) |
| `/srv/data/gallery-cache` | NVMe cache (thumbnails, previews, temp) |
| PostgreSQL | Metadata only (never original files) |

**Scanner & Cache Architecture:**
- **Real-time Watcher:** The scanner uses `chokidar` to detect real-time filesystem events when the drive is active.
- **Reconciliation Scans:** A fast startup scan and manual "Rescan Library" button skips unchanged files (by size and mtime) and generates missing thumbnails/previews.
- **Dual Cache Layer:** 
  - `thumbnails/` (320px) for ultra-fast FileGrid loading.
  - `previews/` (1920px) for high-resolution full-screen MediaViewer.
- **Job Management:** Scans are tracked in the database, viewable in the UI, and can be stopped or deleted. Logs are auto-cleaned to a maximum of 10.

---

## First-Time Setup

### 1. Setup Samsung T7 Mount
Loom requires the Samsung T7 SSD to be permanently mounted at `/media`. USB runtime power management (sleep/wake) is handled entirely by the Linux OS. Loom does not mount, unmount, or suspend the drive.

### 2. Create your `.env` file

```bash
cp /srv/apps/loom/.env.example /srv/apps/loom/.env
nano /srv/apps/loom/.env
```

Fill in all secrets. At minimum:
- `POSTGRES_PASSWORD` — a strong random password
- `OWNER_EMAIL` / `OWNER_PASSWORD` — your admin credentials
- `BETTER_AUTH_SECRET` — a long random string
- `BETTER_AUTH_URL` — your public domain (e.g. `https://loom.example.com`)

### 3. Build and start

```bash
cd /srv/apps/loom
docker compose build
docker compose up -d
```

### 4. Run database migrations and seed

```bash
docker compose exec loom-web npx prisma migrate deploy
docker compose exec loom-web npm run db:seed
```

### 5. Configure Caddy

Add to `/etc/caddy/Caddyfile`:

```caddy
http://loom.example.com {
    reverse_proxy 127.0.0.1:8085
}
```

Reload Caddy:
```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 6. Configure Cloudflare

```bash
cloudflared tunnel route dns your-tunnel loom.example.com
```

---

## Daily Operations

### Check service status
```bash
docker compose ps
docker compose logs loom-web --tail=50
docker compose logs loom-scanner --tail=50
```

### Trigger a manual scan (from settings dashboard)
Login as Owner → Settings → Scanner → Scan Now

### Rebuild after code changes
```bash
cd /srv/apps/loom
docker compose build
docker compose up -d
```

### Stop
```bash
docker compose stop
```

### Remove (preserves database volume)
```bash
docker compose down
```

---

## Security Notes

- Loom containers are **not** privileged.
- The Samsung T7 is permanently mounted by the host OS. Loom has no privileges to mount or unmount it.
- The Samsung T7 is **never modified** by the application. Thumbnails and previews go to `/cache` only.
- All paths exposed to users are relative (e.g. `Pics/Vacation`) — host paths are never leaked.

---

## Absolute Rules (Never Violate)

1. Never delete original files.
2. Never move or rename existing folders automatically.
3. Never reorganize the Samsung T7 filesystem.
4. Never write thumbnails, previews, or metadata onto the T7.
5. The Samsung T7 is the single source of truth.
6. The application adapts to the filesystem — the filesystem never adapts to the application.
