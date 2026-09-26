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

Keep migrations additive: new columns need a default or a backfill, and never drop a column or table that holds user data. People update in place with `./scripts/update.sh` and expect their data to survive. Two indexes live only in migration SQL because Prisma's schema language can't express them: `file_nodes_relativePath_pattern_idx` and the partial unique `file_nodes_live_relativePath_key`. If `prisma migrate dev` ever proposes dropping them, delete those lines from the generated migration.

## Code notes

A few things that aren't obvious from any one file, worth keeping in mind before touching filesystem or API code.

- **API routes.** Wrap handlers in `route()` from web/lib/http.ts and get the caller with `requireUser()` / `requireOwner()`. Throw `HttpError` (or `badRequest`, `forbidden`, …) for expected failures; everything else becomes a generic 500 without leaking internals.
- **Paths.** Never `path.join()` request data yourself. Use `normalizeRelPath()`, `validateName()` and `resolveMediaPath()` from web/lib/fs-guard.ts. An empty string is a valid path, the media root, so check it with `== null`, not `!destDir`.
- **Permissions.** Load an evaluator once per request with `getAcl(user)` (web/lib/acl.ts). Use `canTraverse` for listing, `canAccess` for reading or changing an item, and `canAccessTree` before operating on a folder.
- **Changing files.** Go through web/lib/file-ops.ts. Don't write new ad-hoc fs.rename/fs.rm code in routes; the helpers handle locking, trash-instead-of-overwrite, rollback, and one-statement descendant updates.
- **JSON.** FileNode and ContentIdentity have BigInt fields. Serialize with `serializeListed()` (web/lib/listing.ts) or `toJson()` (web/lib/http.ts).
- **Queries.** Every query for files a user can see needs `inTrash: false`. A folder listing is `parentPath = <folder>`, and new rows must set `parentPath`.
- **Background work.** Queue it with `queueProcessFile()` + `notifyScanner()` (web/lib/jobs.ts), and announce index changes with `publishChange()` (web/lib/events.ts) so open tabs update.
- **Demo.** The public demo (loom-demo/) has no server. Every new JSON API route needs a handler in web/lib/demo/mockServer.ts. Anything loaded by `<img>`, `<video>` or `<a href>` needs web/public/demo-sw.js instead.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the reasoning behind these: idle-drive scanning, dedup by content, trash behavior.

## Pull requests

Keep it to one change per PR, a focused PR is much easier to review than a pile of unrelated fixes. Run docker compose build loom-web loom-scanner and make sure both pass before opening it, CI checks this too but catching it locally is faster. Say what changed and why, not just what, this matters most for filesystem code (path security, trash, collision handling) where the reason usually matters more than the diff. If you changed the schema, mention the migration file name in the PR.

## Bug reports

Open an issue with what you expected versus what actually happened, docker compose logs --tail=200 for the service involved if it's a runtime bug, and whether it happens on a fresh install or only with your existing data.

## Security bugs

Don't open a public issue for a security bug, see [SECURITY.md](SECURITY.md).
