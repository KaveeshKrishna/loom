# CLAUDE.md

Guidance for a Claude Code (or any agent) session picking up this project. If you're new here, also read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the "why" behind the patterns below.

## What Loom is

A self-hosted, permission-aware file manager. Three Docker Compose services:
- **`loom-web`** — Next.js 15 App Router app (standalone build). UI, API routes, auth, file streaming.
- **`loom-scanner`** — long-running Node worker. Indexes the filesystem into Postgres and generates thumbnails/previews/HLS video segments. Polls a DB job queue (`ScanJob`), no filesystem watcher.
- **`postgres`** — metadata only, never file content.

Two bind-mounted volumes, shared by `loom-web` and `loom-scanner`:
- `/media` — the user's real files. Source of truth. Never reorganized. Loom only ever writes into its own sandboxed `/media/.LoomTrash/` and `/media/.tmp-upload/` subdirectories.
- `/cache` — `thumbnails/`, `previews/`, `videos/` (HLS segments). Entirely derived, safe to wipe.

**Core design principle (do not violate when adding features):** the storage drive stays idle by default. No real-time filesystem watcher, no scan on container startup, no hashing during a routine rescan. Rescans compare `size`+`mtime` only (`FileNode.sourceVersion = "${size}-${mtimeMs}"`); a file's content is only actually read when something else already needs to read it (thumbnail generation, video probing, an internal copy). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-idle-drive-principle).

## Directory map

```
compose.yml                    # 3 services: postgres, loom-web, loom-scanner
scripts/                       # install.sh, update.sh, backup-db.sh, uninstall.sh, sync-schema.sh
web/                            # Next.js app
  app/api/                     # API routes (see below)
  app/(auth)/{login,setup}/    # unauthenticated pages
  app/(main)/                  # authenticated pages, wrapped by MainShell
  lib/
    path-security.ts           # resolveAndValidate() — call before ANY filesystem op
    fs-operations.ts           # initFs() — creates .LoomTrash/.tmp-upload on demand
    fs-locks.ts                # in-memory lock to serialize concurrent FS mutations
    collision.ts                # checkCollision() + generateUniqueFilename()
    content-identity.ts         # computeFastHash() — SHA-256 of first+last 1MB
    hls-manager.ts               # region-based HLS generation engine
    acl.ts                       # checkAccess() — hierarchical path-based ACL, deepest rule wins
    auth.ts / auth-client.ts     # better-auth server/client
    utils.ts                     # serializeNode/serializeNodes (BigInt-safe JSON), sortNodes
  prisma/schema.prisma           # source of truth for the schema — see note below
  prisma/migrations/              # tracked migrations, applied by docker-entrypoint.sh on startup
  docker-entrypoint.sh            # runs `prisma migrate deploy`, then execs the server
scanner/
  src/index.ts                   # the entire scanner: indexing, hashing, generation, GC, trash expiry
  prisma/schema.prisma            # MUST stay byte-identical to web's — scripts/sync-schema.sh checks this
docs/                             # INSTALLATION, CONFIGURATION, ARCHITECTURE, REVERSE-PROXY, UPGRADING, TROUBLESHOOTING
```

## Commands

```bash
docker compose build loom-web loom-scanner   # rebuild after code changes
docker compose up -d                          # start/restart (migrations run automatically)
docker compose logs -f loom-web               # web logs
docker compose logs -f loom-scanner           # scanner logs
./scripts/sync-schema.sh [--fix]              # check/fix schema drift between web/ and scanner/
```

Schema changes:
```bash
cd web
npx prisma migrate dev --name describe_change   # generates a new migration
cd .. && ./scripts/sync-schema.sh --fix         # keep scanner's copy in sync
```

There is no `prisma db push` workflow anymore — migrations are real and tracked (see [docs/UPGRADING.md](docs/UPGRADING.md) for the one-time baselining needed on installs that predate this).

## Conventions & gotchas (load-bearing — read before touching related code)

- **BigInt serialization**: any API response containing a `FileNode` or `ContentIdentity` (both have `BigInt` fields, e.g. `size`) MUST go through `serializeNode`/`serializeNodes` from `web/lib/utils.ts` before `NextResponse.json(...)`. A raw BigInt anywhere in the payload throws at serialization time — this has broken every files-listing endpoint at least once before.
- **Trash visibility**: every query for user-visible files needs `inTrash: false` in its `where` clause, or trashed items reappear across the app (All Files, Recent, Search, Favorites, Photos/Videos/Documents type-filtered queries have all had this bug at some point).
- **Path safety**: call `resolveAndValidate(relativePath, context, mustExist)` from `path-security.ts` before touching the filesystem in any route — it blocks traversal (`../`), symlink escapes, and enforces the `media` / `trash` / `upload-temp` sandbox contexts. Never construct an absolute path by hand.
- **Empty string is a valid path**: it means "the media root." Check with `=== null`/`== null`, never `!destDir` — `!""` is `true` and will incorrectly reject root-level operations. This has broken mkdir/copy/move/upload at the root before.
- **Directory move/rename must cascade**: updating a directory's `FileNode.relativePath` does not automatically update its descendants' paths — you must find and update every descendant explicitly, or children disappear from the UI while remaining correct on disk.
- **Trashing a folder must cascade too**: descendants need `inTrash: true` and a rewritten `relativePath` under `.LoomTrash/`, or a new folder created with the same name will appear to "inherit" the old folder's children in the DB.
- **Context menu event bubbling**: `onContextMenu` handlers need both `e.preventDefault()` and `e.stopPropagation()`, or a right-click on a file also triggers the parent empty-space context menu.
- **`useTopBar()`** (and any other hook) must be called before any early `return` in a component — rules-of-hooks, easy to violate when adding a loading-state early return.
- **Next.js 15 dynamic route params are `Promise<{...}>`** — always `await params` in route handlers.
- **Pages that query the DB directly in a Server Component** (`/`, `/login`, `/setup` — used to detect a fresh, user-less install) must export `export const dynamic = "force-dynamic"`, or `next build` tries to statically prerender them with no `DATABASE_URL` available and fails the build.
- **`Role` enum is `OWNER | FAMILY` only** — no `ADMIN`.
- Known IDE false-positives that do **not** affect the actual build: "Cannot find module 'react'/'fs'/'path'", "JSX intrinsic elements" — stale tsconfig path-alias resolution in some editors. If `docker compose build` passes, the code is fine regardless of what the IDE shows.

## First-run / setup flow

There is no seed script. `/api/setup` (POST) creates the first user and promotes it to `OWNER` — it hard-refuses (403) once any user exists, which is the actual security boundary (not the `/setup` page's own redirect, which is just UX). `/`, `/login`, and `/setup` all check `prisma.user.count()` to route a fresh install to setup automatically.

## Known gaps / incomplete work

- **`BackgroundJob` model exists in the schema but nothing references it.** Copy/move/large-folder operations currently run synchronously within the request instead of as a tracked background job. Fine for typical libraries; could stall a request on a very large folder operation. If implementing this, the model already has the shape (`type`, `status`, `payload`, `progress`) — it just needs a worker loop (likely in the scanner, since it already polls a job queue) and a frontend polling/progress UI.
- Scanner health checks in CI/`tsc --noEmit` are enforced; there's no automated test suite (unit or integration) yet for either `web` or `scanner`.

## Absolute rules (never violate)

1. Never delete original files — only ever move them into the sandboxed Trash.
2. Never move or rename existing folders automatically/implicitly.
3. Never reorganize the user's existing folder structure.
4. Write derived media (thumbnails/previews/HLS) only under `/cache` — never onto the media root.
5. The filesystem is the source of truth; the database is only an index of it. If they disagree, the filesystem wins.
6. The application adapts to the user's existing structure — never the other way around.
