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

## One-time step for old installs, from before tracked migrations

Early Loom used prisma db push instead of tracked migrations. If your install is from before migrations existed, the first upgrade needs one extra step. Without it, loom-web won't start, because it tries to run the first migration's CREATE TABLE statements on tables that already exist.

To check if this is you, look for a _prisma_migrations table:

```bash
docker compose exec postgres psql -U loom -d loom -c "\dt _prisma_migrations"
```

If that table isn't there, baseline once before upgrading.

## Baseline steps

Back up first, this doesn't change data but do it anyway:
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
This only writes a bookkeeping row into _prisma_migrations, it doesn't touch your actual tables.

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

loom-web exits instead of starting in a broken state. Check docker compose logs loom-web for the Prisma error. Usual causes are the baseline step above not being done on an old install, or the database being changed outside Loom, a manual ALTER TABLE for example, in a way that conflicts with a migration.

Restore from your last backup if you need to, and open an issue with the exact error if it's not one of those.
