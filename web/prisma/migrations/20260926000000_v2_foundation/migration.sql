-- Loom v2 foundation migration.
--
-- Everything here is additive: new columns (with defaults), new tables, new
-- indexes, one enum value, and a relaxed foreign key. No existing column or
-- table is dropped, and your media files are never touched by migrations.
--
-- It also backfills file_nodes."parentPath" and removes duplicate live rows
-- for the same path (which older versions could create under concurrency)
-- before enforcing uniqueness. Favorites pointing at a removed duplicate are
-- moved to the surviving row first, so nothing user-visible is lost.

-- Trigram search on file names
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterEnum
ALTER TYPE "ScanType" ADD VALUE 'PROCESS_FILE';

-- DropForeignKey
ALTER TABLE "trash_items" DROP CONSTRAINT "trash_items_deletedByUserId_fkey";

-- AlterTable
ALTER TABLE "content_identities" ADD COLUMN     "mediaInfo" JSONB;

-- AlterTable
ALTER TABLE "file_nodes" ADD COLUMN     "parentPath" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "scan_jobs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fileNodeId" TEXT,
ADD COLUMN     "sourceVersion" TEXT;

-- AlterTable
ALTER TABLE "trash_items" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'DELETE',
ALTER COLUMN "deletedByUserId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "destDir" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "received" BIGINT NOT NULL DEFAULT 0,
    "lastModified" BIGINT,
    "mimeType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_sessions_userId_idx" ON "upload_sessions"("userId");

-- CreateIndex
CREATE INDEX "upload_sessions_expiresAt_idx" ON "upload_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE INDEX "favorites_fileNodeId_idx" ON "favorites"("fileNodeId");

-- CreateIndex
CREATE INDEX "file_nodes_parentPath_inTrash_isVisible_idx" ON "file_nodes"("parentPath", "inTrash", "isVisible");

-- CreateIndex
CREATE INDEX "file_nodes_contentIdentityId_idx" ON "file_nodes"("contentIdentityId");

-- CreateIndex
CREATE INDEX "file_nodes_mimeType_modifiedAt_idx" ON "file_nodes"("mimeType", "modifiedAt");

-- CreateIndex
CREATE INDEX "file_nodes_modifiedAt_idx" ON "file_nodes"("modifiedAt");

-- CreateIndex
CREATE INDEX "file_nodes_name_trgm_idx" ON "file_nodes" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "scan_jobs_status_type_requestedAt_idx" ON "scan_jobs"("status", "type", "requestedAt");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "trash_items_deletedByUserId_idx" ON "trash_items"("deletedByUserId");

-- AddForeignKey
ALTER TABLE "trash_items" ADD CONSTRAINT "trash_items_deletedByUserId_fkey" FOREIGN KEY ("deletedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Backfill parentPath ─────────────────────────────────────────────────────
UPDATE "file_nodes"
SET "parentPath" = CASE
  WHEN position('/' in "relativePath") = 0 THEN ''
  ELSE regexp_replace("relativePath", '/[^/]*$', '')
END;

-- ─── Remove duplicate live rows for the same relativePath ────────────────────
-- Keep the oldest row per path; repoint favorites from the duplicates to the
-- survivor.
CREATE TEMP TABLE "_loom_dupes" AS
SELECT id, keep_id FROM (
  SELECT id,
         first_value(id) OVER (PARTITION BY "relativePath" ORDER BY "indexedAt", id) AS keep_id
  FROM "file_nodes"
  WHERE "inTrash" = false
) t
WHERE id <> keep_id;

-- A user may have favorited both copies; drop the duplicate favorite first.
DELETE FROM "favorites" f
USING "_loom_dupes" d
WHERE f."fileNodeId" = d.id
  AND EXISTS (SELECT 1 FROM "favorites" f2 WHERE f2."userId" = f."userId" AND f2."fileNodeId" = d.keep_id);

UPDATE "favorites" f SET "fileNodeId" = d.keep_id
FROM "_loom_dupes" d WHERE f."fileNodeId" = d.id;

-- Carry the content identity over if only the duplicate had one
UPDATE "file_nodes" k SET "contentIdentityId" = x."contentIdentityId"
FROM "_loom_dupes" d JOIN "file_nodes" x ON x.id = d.id
WHERE k.id = d.keep_id AND k."contentIdentityId" IS NULL AND x."contentIdentityId" IS NOT NULL;

DELETE FROM "file_nodes" n USING "_loom_dupes" d WHERE n.id = d.id;

DROP TABLE "_loom_dupes";

-- ─── Indexes Prisma's schema language can't express ─────────────────────────
-- Prefix searches ("relativePath" LIKE 'Photos/%') for moves, folder sizes
-- and deletes. The plain btree index can't serve LIKE under a non-C collation.
CREATE INDEX "file_nodes_relativePath_pattern_idx"
  ON "file_nodes" ("relativePath" text_pattern_ops);

-- At most one live (non-trashed) node per path. Trashed nodes live under
-- .LoomTrash/ with unique names, so they are excluded.
CREATE UNIQUE INDEX "file_nodes_live_relativePath_key"
  ON "file_nodes" ("relativePath") WHERE "inTrash" = false;
