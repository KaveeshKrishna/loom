# Contributing to Loom

Thanks for wanting to help. Loom is a small side project, so reviews might take a while.

## License, first

Loom uses the [PolyForm Noncommercial License 1.0.0](LICENSE), which is not an OSI open-source license. If you send a pull request, you're agreeing your code goes out under the same license, free for noncommercial use, but commercial use needs my permission. If you're not okay with that, please don't open a PR. Issues, questions, and bug reports are still welcome either way.

## Setup

You need Docker with Compose v2, Node.js 22+ if you want editor tooling and linting outside containers, and git.

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
cp .env.example .env
# edit .env, for local dev LOOM_MEDIA_PATH and LOOM_CACHE_PATH can be
# throwaway folders like ./dev-data/media and ./dev-data/cache
docker compose up -d
```

Rebuild after changing anything in web/ or scanner/:

```bash
docker compose build loom-web loom-scanner
docker compose up -d
```

To iterate faster on the web app you can run it outside Docker against the Docker Postgres:

```bash
cd web
npm install --legacy-peer-deps
DATABASE_URL=postgresql://loom:<password from .env>@localhost:5432/loom npm run dev
```

For that you need Postgres's port exposed in compose.yml, or run postgres on its own.

## Schema changes

The Prisma schema is in web/prisma/schema.prisma. The copy in scanner/prisma/schema.prisma has to match it exactly, so run ./scripts/sync-schema.sh --fix after editing. To make a migration:

```bash
cd web
npx prisma migrate dev --name describe_your_change
```

That writes a new migration under web/prisma/migrations/. Commit the SQL it generates and don't edit old migrations by hand.

## Code notes

A few things that aren't obvious from any one file, worth keeping in mind before touching filesystem or API code.

Any API response with a FileNode or ContentIdentity in it has to go through serializeNode or serializeNodes from web/lib/utils.ts, both types have BigInt fields that break normal JSON serialization. Every query for files a user can see needs inTrash: false in the where, or trashed files show up all over the app. Call resolveAndValidate() from web/lib/path-security.ts before any filesystem operation, don't build absolute paths yourself. An empty string is a valid path, it means the media root, check it with == null and not !destDir. Moving, renaming, or trashing a folder has to cascade to every child FileNode's relativePath and inTrash, or the children get out of sync with the disk.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the reasoning behind these: idle-drive scanning, dedup by content, trash behavior.

## Pull requests

Keep it to one change per PR, a focused PR is much easier to review than a pile of unrelated fixes. Run docker compose build loom-web loom-scanner and make sure both pass before opening it, CI checks this too but catching it locally is faster. Say what changed and why, not just what, this matters most for filesystem code (path security, trash, collision handling) where the reason usually matters more than the diff. If you changed the schema, mention the migration file name in the PR.

## Bug reports

Open an issue with what you expected versus what actually happened, docker compose logs --tail=200 for the service involved if it's a runtime bug, and whether it happens on a fresh install or only with your existing data.

## Security bugs

Don't open a public issue for a security bug, see [SECURITY.md](SECURITY.md).
