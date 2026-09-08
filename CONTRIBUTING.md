# Contributing to Loom

Thanks for considering it. Loom is a small project maintained in spare time — please be patient with review turnaround.

## Before you contribute: license terms

Loom is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE), not an OSI-approved open-source license. By submitting a contribution, you agree it will be distributed under those same terms — meaning your contribution, like the rest of the project, may be used freely for noncommercial purposes, but commercial use requires the maintainer's permission. If that's not something you're comfortable with, please don't open a PR; issues, discussion, and bug reports are still very welcome regardless.

## Development setup

Requirements: Docker + Docker Compose v2, Node.js 22+ (for editor tooling/linting outside containers), `git`.

```bash
git clone https://github.com/kaveeshkrishna/loom.git
cd loom
cp .env.example .env
# edit .env — for local dev, LOOM_MEDIA_PATH/LOOM_CACHE_PATH can point
# at throwaway local directories, e.g. ./dev-data/media, ./dev-data/cache
docker compose up -d
```

Rebuild after changing `web/` or `scanner/` source:
```bash
docker compose build loom-web loom-scanner
docker compose up -d
```

For faster iteration on the web app specifically, you can run it outside Docker against the Dockerized Postgres:
```bash
cd web
npm install --legacy-peer-deps
DATABASE_URL=postgresql://loom:<password from .env>@localhost:5432/loom npm run dev
```
(You'll need to expose Postgres's port in `compose.yml` locally, or run `postgres` standalone, for this.)

## Schema changes

The Prisma schema lives in `web/prisma/schema.prisma`; `scanner/prisma/schema.prisma` must stay byte-identical (`./scripts/sync-schema.sh --fix` after editing). When changing the schema:

```bash
cd web
npx prisma migrate dev --name describe_your_change
```

This generates a new migration under `web/prisma/migrations/`. Commit the generated SQL — don't hand-edit past migrations.

## Code conventions

A few load-bearing patterns that aren't obvious from reading any single file — please keep these in mind before touching filesystem or API-route code:

- Any API response containing a `FileNode` or `ContentIdentity` must go through `serializeNode`/`serializeNodes` (`web/lib/utils.ts`) — both have `BigInt` fields that throw on plain `JSON` serialization otherwise.
- Every query for user-visible files needs `inTrash: false` in its `where` clause, or trashed items reappear across the app.
- Call `resolveAndValidate()` (`web/lib/path-security.ts`) before any filesystem operation — never construct an absolute path by hand.
- Empty string is a valid path (it means the media root) — check with `== null`, never `!destDir`.
- Moving/renaming/trashing a directory must cascade to all descendant `FileNode`s' `relativePath`/`inTrash`, or children silently desync from disk.
- See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design principles (idle-drive scanning, content-based deduplication, trash semantics) behind these rules.

## Pull requests

- Keep PRs focused — one logical change per PR is much easier to review than a bundle of unrelated fixes.
- Run `docker compose build loom-web loom-scanner` locally and confirm both succeed before opening a PR; CI will re-check this but it's faster to catch locally.
- Describe what changed and why, not just what — especially for anything touching filesystem operations (path security, trash, collision handling), where the "why" often matters more than the diff.
- If your change touches the schema, mention the migration file name in the PR description.

## Reporting bugs

Open an issue with:
- What you expected vs. what happened
- `docker compose logs --tail=200` for the relevant service, if it's a runtime issue
- Whether it reproduces on a fresh install or only on your existing data

## Reporting security issues

Please don't open a public issue for a security vulnerability — see [SECURITY.md](SECURITY.md).
