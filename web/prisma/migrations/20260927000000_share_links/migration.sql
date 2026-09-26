-- Share links (additive: one new table).

-- CreateTable
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT,
    "fileNodeId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "passwordHash" TEXT,
    "allowDownload" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessedAt" TIMESTAMP(3),
    "accessCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_links_tokenHash_key" ON "share_links"("tokenHash");

-- CreateIndex
CREATE INDEX "share_links_fileNodeId_idx" ON "share_links"("fileNodeId");

-- CreateIndex
CREATE INDEX "share_links_createdById_idx" ON "share_links"("createdById");

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_fileNodeId_fkey" FOREIGN KEY ("fileNodeId") REFERENCES "file_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

