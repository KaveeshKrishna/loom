# Upgrading

## Normal upgrades

```bash
./scripts/update.sh
```

This pulls the latest code (if you're running from a git clone), backs up the database, rebuilds the images, and restarts. Database migrations are applied automatically by `loom-web`'s container entrypoint on startup — there is no manual migration step in the normal case.

Or by hand:

```bash
git pull --ff-only
./scripts/backup-db.sh
docker compose build
docker compose up -d
```

## One-time step: upgrading from a pre-migrations install

Early Loom deployments applied the database schema with `prisma db push` rather than tracked migrations. If your install predates versioned migrations, the very first upgrade needs one extra step — otherwise `loom-web` will fail to start, because it will try to run the initial migration's `CREATE TABLE` statements against tables that already exist.

**How to tell if this applies to you:** connect to the database and check for a `_prisma_migrations` table.

```bash
docker compose exec postgres psql -U loom -d loom -c "\dt _prisma_migrations"
```

If that table doesn't exist, you need to baseline once before upgrading.

### Baselining steps

1. **Back up first.** This step doesn't modify data, but back up anyway:
   ```bash
   ./scripts/backup-db.sh
   ```

2. **Pull the new code and build the new image** (don't start it yet):
   ```bash
   git pull --ff-only
   docker compose build loom-web
   ```

3. **Mark the initial migration as already applied**, since your existing tables already match it:
   ```bash
   docker compose run --rm --entrypoint sh loom-web -c \
     "node /opt/prisma-cli/node_modules/prisma/build/index.js migrate resolve --applied 20260101000000_init"
   ```
   This only writes a bookkeeping row into `_prisma_migrations` — it does not touch your actual tables.

4. **Now start normally:**
   ```bash
   docker compose up -d
   ```
   The entrypoint's `prisma migrate deploy` will see the initial migration is already marked applied and skip straight to any newer migrations.

5. Confirm both containers report healthy:
   ```bash
   docker compose ps
   ```

You only need to do this once. Every subsequent upgrade is the normal flow above.

## If a migration fails

`loom-web` will exit rather than start in a broken state — check `docker compose logs loom-web` for the Prisma error. Common causes:
- The baselining step above wasn't done on a pre-migrations install.
- The database was modified out-of-band (e.g. manual `ALTER TABLE`) in a way that conflicts with a migration.

Restore from your last backup (`./scripts/backup-db.sh` output) if needed, and open an issue with the exact error if it's not one of the above.
