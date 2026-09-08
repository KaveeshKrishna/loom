# Troubleshooting

## Permission denied writing to cache

The `loom-web` container runs as the built-in `node` user, UID/GID `1000:1000` — this matches how most Linux distros number their first regular user, but if your `LOOM_CACHE_PATH` directory was created by a different user (or root), Loom won't be able to write thumbnails/previews/HLS segments into it.

Fix:
```bash
sudo chown -R 1000:1000 /path/to/your/cache
```

`scripts/install.sh` attempts this automatically for a newly-created cache directory, but can't if it doesn't have permission to `chown` (e.g. not run with sudo and the directory isn't yours) — it'll warn you in that case.

`LOOM_MEDIA_PATH` does not need this — Loom only needs read access to most of it, plus write access to its own `.LoomTrash/` and `.tmp-upload/` subdirectories, which it creates itself on first use.

## Files added to the drive don't show up

Loom does not watch the filesystem in real time (see [Architecture](ARCHITECTURE.md#the-idle-drive-principle) for why) — new files only appear after a manual rescan: **Settings → Scanner → Scan Now** (Owner only). Check **Settings → Scanner** for job status/errors if a rescan doesn't pick up what you expect.

## A video won't play / keeps buffering

- Check `docker compose logs -f loom-web` for `[HLS]`/`[HLS-seg]` log lines while attempting playback.
- The first request to a new region of an incompatible-format video has to wait for FFmpeg to actually produce that segment — a few seconds is normal for large/high-bitrate source files. If it never resolves, the container may be resource-constrained (HLS transcoding is CPU-bound); check `docker stats`.
- If you previously saw errors and the browser has cached a broken/truncated segment response, hard-refresh (or clear site data for the Loom origin) before assuming it's still broken server-side.
- Confirm `ffmpeg` is present and working inside the container: `docker compose exec loom-web ffmpeg -version`.

## A file is shown as "Corrupt" or "Unsupported" and I don't think it should be

Check **File Health** in the sidebar — it distinguishes the two:
- **Unsupported** means the file is valid, but Loom's current thumbnail/preview/probe pipeline doesn't handle that format. This is not data loss.
- **Corrupt** means Loom attempted to read/analyze the file and it appears structurally damaged (a truncated video with no `moov atom`, for instance).

Both statuses are tied to the exact file version at the time of the check (its size+mtime). If you replace the file with a working copy, a rescan re-evaluates it. There's also an explicit "Retry Analysis" action on the File Health page that bypasses the cached result without needing a full rescan.

## Setup page won't let me create an account / says setup is already complete

The `/setup` page and its API are only reachable while the user table is empty — this is intentional, to prevent it from ever becoming a way to create a second privileged account later. If you need to add more users after initial setup, use **Settings → Users** as the Owner instead.

If you're locked out entirely (lost the Owner password, no other Owner account), you'll need direct database access to reset it — there is currently no self-service password reset flow.

## Scanner container keeps restarting

```bash
docker compose logs loom-scanner --tail=100
```

Common causes:
- `LOOM_MEDIA_PATH` doesn't exist or isn't readable by the container — check the path in `.env` actually exists on the host.
- Database not reachable yet — the scanner depends on `postgres` being healthy; check `docker compose ps`.

## Schema drift between web/ and scanner/

If you've hand-edited `web/prisma/schema.prisma` without touching `scanner/prisma/schema.prisma` (or vice versa), the scanner's generated Prisma client can disagree with the actual database schema. Run:

```bash
./scripts/sync-schema.sh          # checks; exits non-zero if out of sync
./scripts/sync-schema.sh --fix    # copies web's schema over scanner's
```

## Still stuck?

Open an issue with:
- `docker compose logs --tail=200` for the affected service
- Your Loom version / commit
- Whether this is a fresh install or an upgrade (and from what version, if so)
