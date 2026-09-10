# Upgrading

## Normal upgrade

```bash
./scripts/update.sh
```

This pulls the latest code (if you're on a git clone), backs up the database, rebuilds the images, and restarts. Migrations run when the container starts, so there's usually no manual step.

By hand:

```bash
git pull --ff-only
./scripts/backup-db.sh
docker compose build
docker compose up -d
```

## One-time step for old installs (from before tracked migrations)

Early Loom used `prisma db push` instead of tracked migrations. If your install is from before migrations existed, the first upgrade needs one extra step. Without it, `loom-web` won't start, because it tries to run the first migration's `CREATE TABLE` statements on tables that are already there.

**Check if this is you:** look for a `_prisma_migrations` table.

```bash
docker compose exec postgres psql -U loom -d loom -c "\dt _prisma_migrations"
```

If that table isn't there, baseline once before upgrading.

### Baseline steps

1. **Back up.** This doesn't change data, but back up anyway:
   ```bash
   ./scripts/backup-db.sh
   ```

2. **Pull and build the new image, but don't start it:**
   ```bash
   git pull --ff-only
   docker compose build loom-web
   ```

3. **Mark the first migration as already applied,** since your tables already match it:
   ```bash
   docker compose run --rm --entrypoint sh loom-web -c \
     "node /opt/prisma-cli/node_modules/prisma/build/index.js migrate resolve --applied 20260101000000_init"
   ```
   This only writes a bookkeeping row into `_prisma_migrations`. It doesn't touch your tables.

4. **Start normally:**
   ```bash
   docker compose up -d
   ```
   `prisma migrate deploy` sees the first migration is marked applied and jumps to any newer ones.

5. Check both containers are healthy:
   ```bash
   docker compose ps
   ```

You only do this once. Every upgrade after is the normal flow above.

## If a migration fails

`loom-web` exits instead of starting in a broken state. Check `docker compose logs loom-web` for the Prisma error. Usual causes:
- The baseline step above wasn't done on an old install.
- The database was changed outside Loom (a manual `ALTER TABLE`) in a way that conflicts with a migration.

Restore from your last backup if you need to, and open an issue with the exact error if it's not one of those.
