# Upgrading

## Updating

From your Loom folder:

```bash
./scripts/update.sh
```

This is the safe way to update. It:

1. Checks that Docker is running and your .env is valid, and stops if you've edited any of Loom's files, so your edits are never overwritten.
2. Shows the version you're going to, the list of changes, and whether the database changes. Then it asks before doing anything.
3. Backs up the database to backups/ and checks the backup is complete. If the backup fails, it stops and nothing changes.
4. Downloads the new code. It only ever fast-forwards: it never merges or throws anything away.
5. Builds the new images while the current version keeps running. If the build fails, it puts the code back and Loom keeps running as before.
6. Restarts Loom, which applies any database changes, then waits until the web app and the scanner are both healthy.

Your media folder is never touched by any of this. Only the code, the Docker images and the database change. Files like .env, data/ and backups/ are never touched either.

Other options:

```bash
./scripts/update.sh --check      # is there a new version? (exit code 2 = yes)
./scripts/update.sh --yes        # no questions, e.g. from cron
./scripts/update.sh --rebuild    # rebuild even if up to date, to pick up security fixes in the base images
./scripts/update.sh --rollback   # go back to the version before the last update
```

Read CHANGELOG.md before a big update. Anything you need to do by hand is listed there and below.

## Going back (rollback)

```bash
./scripts/update.sh --rollback
```

This moves the code back to the version you had before the last update, rebuilds and restarts. It also offers to restore the database backup taken just before that update. You usually don't need that: Loom's database changes only ever add things, so the older version runs fine on the updated database. Restore it only if the update failed while changing the database. Restoring loses whatever changed in the database since the update (new users, favorites, share links). Your files on disk stay as they are either way.

After a rollback, update.sh will offer the same version again next time and warn you that you rolled back from it. Wait for a fixed version.

## Backups and restores

```bash
./scripts/backup-db.sh                                   # back up now
./scripts/restore-db.sh backups/loom-20260101-120000.sql.gz   # restore one
```

Backups hold the database only: users, the file index, favorites, permissions, share links and the audit log. They don't include your media (back that up yourself, like any important data) or the thumbnail cache (Loom rebuilds it). The newest 10 are kept; set LOOM_KEEP_BACKUPS to keep more. A restore backs up the current database first, so it can be undone too.

## Updating by hand

If you'd rather not use the script:

```bash
./scripts/backup-db.sh
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps        # wait until loom-web says (healthy)
```

## Upgrading to 2.0

2.0 is a big release (see CHANGELOG.md). Things to know:

- If your Loom was set up before 2.0, the update.sh on your server is the old, simpler one. Just run it as usual: it pulls the new code, backs up with the new backup script, rebuilds and restarts. Every update after that uses the new script. Note your current version first with `git rev-parse --short HEAD`, because the old script doesn't record it for --rollback. To go back by hand: `git reset --hard <that commit>` then `docker compose up -d --build`.
- The database migration adds columns and indexes and fills them in. On a big library the first start can take a few minutes; loom-web shows as starting until it's done. If two index rows point at the same path (which older versions could create), the extras are removed and their favorites moved to the one that's kept. Nothing on disk changes.
- The scanner now runs as the unprivileged node user (uid 1000) instead of root. On first start it gives any root-owned files in the cache folder to that user. Only the cache is changed, never the media folder. The scanner also needs to be able to read your media as uid 1000, which loom-web already needed.
- Thumbnails are regenerated with the correct rotation for photos taken sideways. This happens in the background as you browse. To do it all at once, run Scan Now in Settings.
- Public sign-up is closed. New accounts are created by the Owner in Settings, Users. If you had relied on people signing up themselves, add them there.
- BETTER_AUTH_SECRET must be set to a real value. If it's empty or still the example value, loom-web won't start. Generate one with `openssl rand -base64 48`. Changing it signs everyone out.
- Share links are off until the Owner turns them on in Settings, Sharing.
- If you use a reverse proxy, check docs/REVERSE-PROXY.md: uploads now go in 32 MB chunks, and live updates use a long-lived connection to /api/events that must not be buffered.

## One-time step for old installs, from before tracked migrations

Early Loom used prisma db push instead of tracked migrations. If your install is from before migrations existed, the first upgrade needs one extra step. Without it, loom-web won't start, because it tries to run the first migration's CREATE TABLE statements on tables that already exist.

To check if this is you, look for a _prisma_migrations table:

```bash
docker compose exec postgres psql -U loom -d loom -c "\dt _prisma_migrations"
```

If that table isn't there, baseline once before upgrading.

### Baseline steps

Back up first. This doesn't change data, but do it anyway:
```bash
./scripts/backup-db.sh
```

Pull and build the new image, but don't start it yet:
```bash
git pull --ff-only
docker compose build loom-web
```

Mark the first migration as already applied, since your tables already match it:
```bash
docker compose run --rm --entrypoint sh loom-web -c \
  "node /opt/prisma-cli/node_modules/prisma/build/index.js migrate resolve --applied 20260101000000_init"
```
This only writes a bookkeeping row into _prisma_migrations. It doesn't touch your actual tables.

Then start normally:
```bash
docker compose up -d
```
prisma migrate deploy sees the first migration is marked applied and jumps straight to any newer ones.

Check both containers are healthy:
```bash
docker compose ps
```

You only do this once. Every upgrade after is the normal flow above.

## If a migration fails

loom-web exits instead of starting in a broken state, and update.sh shows its log and offers to roll back. Usual causes are the baseline step above not being done on an old install, or the database being changed outside Loom (a manual ALTER TABLE, for example) in a way that conflicts with a migration.

To recover, run `./scripts/update.sh --rollback` and say yes to restoring the database. Then open an issue with the exact error from `docker compose logs loom-web`.

## Local changes

update.sh refuses to run if you've edited files that are part of Loom (for example compose.yml). To keep your edits across updates, put them in a compose.override.yml file instead. Docker Compose reads it automatically on top of compose.yml, and git ignores it, so updates never conflict with it. To set your edits aside for an update:

```bash
git stash            # set your edits aside
./scripts/update.sh
git stash pop        # put them back
```
