/**
 * content-identity.ts
 *
 * A ContentIdentity is "this exact content", independent of where it lives.
 * Derived media (thumbnails, previews, HLS) hangs off it, so N identical
 * files share one cache. Identity = file size + SHA-256 of the first and last
 * 1 MB. It is computed lazily — only when Loom reads the file anyway (the
 * scanner making a thumbnail, the web app starting a video transcode) —
 * never during a metadata-only rescan.
 *
 * The scanner has its own copy of the hash function (scanner/src/media.ts);
 * the two must stay identical.
 */

import { createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { prisma } from "./prisma";

const HASH_CHUNK_SIZE = 1024 * 1024;

async function hashRange(hash: ReturnType<typeof createHash>, path: string, start: number, end: number) {
  if (end < start) return;
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path, { start, end });
    s.on("data", (c) => hash.update(c));
    s.on("end", resolve);
    s.on("error", reject);
  });
}

/** SHA-256(first 1 MB || last 1 MB). Whole file for files up to 2 MB. */
export async function computeFastHash(absolutePath: string, size?: number): Promise<string> {
  const fileSize = size ?? (await stat(absolutePath)).size;
  const hash = createHash("sha256");
  await hashRange(hash, absolutePath, 0, Math.min(HASH_CHUNK_SIZE, fileSize) - 1);
  if (fileSize > HASH_CHUNK_SIZE) {
    await hashRange(hash, absolutePath, Math.max(HASH_CHUNK_SIZE, fileSize - HASH_CHUNK_SIZE), fileSize - 1);
  }
  return hash.digest("hex");
}

/** Find or create the identity for a file and link the node to it. */
export async function resolveAndLinkContentIdentity(absolutePath: string, fileNodeId: string): Promise<string> {
  const { size } = await stat(absolutePath);
  const fastHash = await computeFastHash(absolutePath, size);
  const identity = await prisma.contentIdentity.upsert({
    where: { size_fastHash: { size: BigInt(size), fastHash } },
    update: {},
    create: { size: BigInt(size), fastHash },
  });
  await prisma.fileNode.update({ where: { id: fileNodeId }, data: { contentIdentityId: identity.id } });
  return identity.id;
}

export const THUMBNAIL_PROFILE_VERSION = "v2";
export const PREVIEW_PROFILE_VERSION = "v2";
