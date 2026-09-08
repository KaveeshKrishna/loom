/**
 * content-identity.ts
 *
 * Lazy content-identity resolution for Loom's deduplication system.
 *
 * ARCHITECTURE:
 *   - A ContentIdentity record represents unique file *content*, not a path.
 *   - Multiple FileNodes can reference the same ContentIdentity.
 *   - Derived media (thumbnails, previews, HLS) belongs to ContentIdentity,
 *     so N identical files share ONE physical thumbnail/preview.
 *
 * HASHING PHILOSOPHY (preserves idle-SSD optimization):
 *   - A fast-hash (SHA-256 of first 1MB + last 1MB) is computed ONLY when
 *     Loom is already reading the file for another reason (thumbnail gen,
 *     video probe, Loom-managed copy, explicit dedup op).
 *   - NEVER called during a plain metadata-only Rescan pass.
 *   - The fast-hash is a highly reliable candidate identity, not a mathematical
 *     proof of bit-for-bit equality.
 */

import { createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { PrismaClient } from "@prisma/client";

const HASH_CHUNK_SIZE = 1024 * 1024; // 1 MB

/**
 * Compute the Loom fast-hash for a file:
 *   SHA-256( first_1MB_bytes || last_1MB_bytes )
 *
 * For files ≤ 2MB, this hashes the entire file content.
 * For larger files it samples head and tail — fast and practically unique.
 */
export async function computeFastHash(absolutePath: string): Promise<string> {
  const fileStat = await stat(absolutePath);
  const fileSize = fileStat.size;

  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");

    // Read first 1MB
    const headEnd = Math.min(HASH_CHUNK_SIZE, fileSize) - 1;
    const headStream = createReadStream(absolutePath, { start: 0, end: headEnd });

    headStream.on("data", (chunk) => hash.update(chunk));
    headStream.on("error", reject);
    headStream.on("end", () => {
      if (fileSize <= HASH_CHUNK_SIZE) {
        // File is ≤ 1MB — head stream already covered everything
        resolve(hash.digest("hex"));
        return;
      }

      // Read last 1MB (non-overlapping with head if file > 2MB)
      const tailStart = Math.max(HASH_CHUNK_SIZE, fileSize - HASH_CHUNK_SIZE);
      const tailStream = createReadStream(absolutePath, { start: tailStart });

      tailStream.on("data", (chunk) => hash.update(chunk));
      tailStream.on("error", reject);
      tailStream.on("end", () => resolve(hash.digest("hex")));
    });
  });
}

/**
 * Resolve or create a ContentIdentity record for a file.
 *
 * Call this ONLY when the file is already being read (thumbnail gen, video
 * probe, Loom-managed copy). Never call during a metadata-only Rescan.
 *
 * @returns The ContentIdentity record id
 */
export async function resolveContentIdentity(
  absolutePath: string,
  prisma: PrismaClient
): Promise<string> {
  const fileStat = await stat(absolutePath);
  const size = BigInt(fileStat.size);
  const fastHash = await computeFastHash(absolutePath);

  const identity = await prisma.contentIdentity.upsert({
    where: { size_fastHash: { size, fastHash } },
    update: {},
    create: { size, fastHash },
  });

  return identity.id;
}

/**
 * Link an existing FileNode to its ContentIdentity.
 * Updates contentIdentityId on the FileNode record.
 */
export async function linkFileNodeToContentIdentity(
  fileNodeId: string,
  contentIdentityId: string,
  prisma: PrismaClient
): Promise<void> {
  await prisma.fileNode.update({
    where: { id: fileNodeId },
    data: { contentIdentityId },
  });
}

/**
 * Resolve content identity and link a FileNode in one call.
 * Use this inside thumbnail generation, video probe, or upload finalization.
 */
export async function resolveAndLinkContentIdentity(
  absolutePath: string,
  fileNodeId: string,
  prisma: PrismaClient
): Promise<string> {
  const contentIdentityId = await resolveContentIdentity(absolutePath, prisma);
  await linkFileNodeToContentIdentity(fileNodeId, contentIdentityId, prisma);
  return contentIdentityId;
}

/**
 * When a file's sourceVersion changes (content may have changed), nullify its
 * contentIdentityId to force lazy re-evaluation on the next access.
 */
export async function invalidateContentIdentity(
  fileNodeId: string,
  prisma: PrismaClient
): Promise<void> {
  await prisma.fileNode.update({
    where: { id: fileNodeId },
    data: { contentIdentityId: null },
  });
}

/**
 * For a Loom-initiated copy: the destination FileNode inherits the same
 * contentIdentityId as the source without any hashing needed.
 */
export async function inheritContentIdentity(
  sourceFileNodeId: string,
  destFileNodeId: string,
  prisma: PrismaClient
): Promise<void> {
  const source = await prisma.fileNode.findUnique({
    where: { id: sourceFileNodeId },
    select: { contentIdentityId: true },
  });
  if (source?.contentIdentityId) {
    await linkFileNodeToContentIdentity(
      destFileNodeId,
      source.contentIdentityId,
      prisma
    );
  }
}

/**
 * Profile version constants.
 * Increment when generation parameters change to prevent stale cache reuse.
 */
export const THUMBNAIL_PROFILE_VERSION = "v1";
export const PREVIEW_PROFILE_VERSION = "v1";
export const HLS_PROFILE_VERSION = "v1";
