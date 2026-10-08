# Contributing to Loom

Thanks for considering it. Loom is a small project maintained in spare time, so please be patient with review turnaround.

## Before you contribute: license terms

Loom is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE), not an OSI-approved open-source license. By submitting a contribution, you agree it will be distributed under those same terms: your contribution, like the rest of the project, may be used freely for noncommercial purposes, but commercial use requires the maintainer's permission. If you're not comfortable with that, please don't open a PR. Issues, discussion and bug reports are still very welcome.

## Development setup

Requirements: Docker with Compose v2, Node.js 22+ (for editor tooling and linting outside the containers), and `git`.

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
cp .env.example .env
# Edit .env. For local development, LOOM_MEDIA_PATH and LOOM_CACHE_PATH can
# point at throwaway folders, e.g. ./dev-data/media and ./dev-data/cache.
# Set a real BETTER_AUTH_SECRET (openssl rand -base64 48); loom-web refuses
# to start with the example value.
docker compose up -d
```

Rebuild after changing anything in `web/` or `scanner/`:

```bash
docker compose build loom-web loom-scanner
docker compose up -d
```

For faster iteration on the web app, run it outside Docker against the Dockerized Postgres:

```bash
cd web
npm install --legacy-peer-deps
DATABASE_URL=postgresql://loom:<password from .env>@localhost:5432/loom npm run dev
```

For that you need Postgres's port exposed. Do it in a `compose.override.yml` (git ignores it, so it never conflicts with updates), or run Postgres on its own.

## What CI checks

Every push and PR to `main` or `dev` runs `.github/workflows/ci.yml`:

| Job | What it checks |
|---|---|
| Schema sync | `web/` and `scanner/` Prisma schemas are byte-identical |
| shellcheck | All shell scripts pass `shellcheck -x` |
| Migrations | Every migration applies to an empty database, and the result matches the schema |
| web | `npm run lint`, `tsc --noEmit`, `npm run build` |
| scanner | `tsc --noEmit` |
| Docker | The real installer runs non-interactively, the scanner runs as `node`, `/api/health` reports the right version, backup works, and `update.sh` runs |

There is no unit test suite yet, so please describe how you tested your change.

## Schema changes

The Prisma schema lives in `web/prisma/schema.prisma`. `scanner/prisma/schema.prisma` must stay byte-identical; run `./scripts/sync-schema.sh --fix` after editing. To create a migration:

```bash
cd web
npx prisma migrate dev --name describe_your_change
```

This generates a new migration under `web/prisma/migrations/`. Commit the generated SQL, and don't hand-edit past migrations.

**Keep migrations additive.** New columns need a default or a backfill, and never drop a column or table that holds user data. People update in place with `./scripts/update.sh`, expect their data to survive, and may roll back to the previous version, which must still run on the new database.

Two indexes live only in migration SQL because Prisma's schema language can't express them: `file_nodes_relativePath_pattern_idx` and the partial unique index `file_nodes_live_relativePath_key`. If `prisma migrate dev` ever proposes dropping them, delete those lines from the generated migration.

## Code conventions

A few load-bearing patterns that aren't obvious from reading any single file. Please follow them when touching API routes or anything that changes files.

- **API routes.** Wrap handlers in `route()` from `web/lib/http.ts`, and get the caller with `requireUser()` or `requireOwner()`. Throw `HttpError` (or `badRequest`, `forbidden`, `notFound`, `conflict`) for expected failures; anything else becomes a generic 500 that doesn't leak internals. Route files may only export handlers and Next.js route config (`dynamic`, etc.), or the production build fails.
- **Paths.** Never `path.join()` request data yourself. Use `normalizeRelPath()`, `validateName()` and `resolveMediaPath()` from `web/lib/fs-guard.ts`. The empty string is a valid path (the media root), so check with `== null`, never `!destDir`.
- **Permissions.** Load an evaluator once per request with `getAcl(user)` (`web/lib/acl.ts`). Use `canTraverse` for listing, `canAccess` for reading or changing an item, and `canAccessTree` before operating on a folder as a whole.
- **Changing files.** Go through `web/lib/file-ops.ts` (and `transfer.ts` for conflict-aware copy/move). Don't write new ad-hoc `fs.rename` / `fs.rm` code in routes; the helpers handle locking, Trash-instead-of-overwrite, rollback, crash-safe temp files, and one-statement descendant updates.
- **Crash safety.** Anything that writes a file in more than one step must write to a `.loom-tmp-…` name and register a journal entry (`web/lib/fs-journal.ts`) so recovery can clean up after a power cut.
- **JSON.** `FileNode` and `ContentIdentity` have `BigInt` fields. Serialize with `serializeListed()` (`web/lib/listing.ts`) or `toJson()` (`web/lib/http.ts`); a raw BigInt throws at serialization time.
- **Queries.** Every query for files a user can see needs `inTrash: false`. A folder listing is `parentPath = <folder>`, and new rows must set `parentPath`.
- **Background work.** Queue it with `queueProcessFile()` + `notifyScanner()` (`web/lib/jobs.ts`), and announce index changes with `publishChange()` (`web/lib/events.ts`) so open tabs update.
- **The idle-drive rule.** No filesystem watchers, no scanning on startup, no reading file contents during a rescan. See [ARCHITECTURE.md](docs/ARCHITECTURE.md#keeping-the-drive-idle).
- **Scripts.** Shell scripts in `scripts/` share helpers from `scripts/lib.sh` and must pass `shellcheck -x`. They must never write to, move, delete or chown anything under `LOOM_MEDIA_PATH`.
- **The demo.** The public demo (`loom-demo/`) has no server. Every new JSON API route needs a handler in `web/lib/demo/mockServer.ts`; anything loaded by `<img>`, `<video>` or `<a href>` needs `web/public/demo-sw.js` instead. See [loom-demo/README.md](loom-demo/README.md).

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the design behind these rules.

## Releases

1. Bump `VERSION`, and the `version` in `web/package.json` and `scanner/package.json`.
2. Add a section to [CHANGELOG.md](CHANGELOG.md), including anything people must do by hand. `update.sh` shows the version and change list before updating.
3. If there are manual steps, add a version note to [docs/UPGRADING.md](docs/UPGRADING.md).

## Pull requests

- Keep PRs focused. One logical change per PR is much easier to review than a bundle of unrelated fixes.
- Run `docker compose build loom-web loom-scanner` locally and make sure both succeed before opening a PR. CI re-checks this, but it's faster to catch locally.
- Describe what changed and **why**, especially for anything touching filesystem operations, path validation, permissions or Trash, where the reason often matters more than the diff.
- If your change touches the schema, mention the migration name in the PR description.
- If it adds or changes an API route, say whether the demo's `mockServer.ts` was updated.

## Reporting bugs

Open an issue (there's a template) with:

- what you expected versus what happened;
- `docker compose logs --tail=200` for the relevant service, if it's a runtime issue;
- your Loom version (`cat VERSION`);
- whether it reproduces on a fresh install or only with your existing data.

## Reporting security issues

Please don't open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md).
