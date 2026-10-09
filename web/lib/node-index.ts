/**
 * node-index.ts
 *
 * Helpers that keep the FileNode index in step with changes Loom itself makes
 * on disk (uploads, mkdir, copy, edits). The filesystem is always the source
 * of truth: these read real stat() data rather than trusting request input.
 */

import fs from "fs/promises";
import path from "path";
import mime from "mime-types";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { MEDIA_ROOT } from "./path-security";
import { parentOf, baseName, likeEscape } from "./fs-guard";

type Tx = Prisma.TransactionClient | typeof prisma;

export function sourceVersionOf(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}-${stat.mtimeMs}`;
}

export function mimeTypeOf(name: string): string | null {
  return mime.lookup(name) || null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Make sure a DIRECTORY node exists for `relDir` and each of its ancestors.
 * Missing directories on disk are skipped (they can't be indexed).
 * Returns the ones it created.
 */
export async function ensureDirectoryNodes(relDir: string, tx: Tx = prisma): Promise<string[]> {
  const created: string[] = [];
  if (!relDir) return created;
  const segments = relDir.split("/");
  const wanted = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  const existing = await tx.fileNode.findMany({
    where: { relativePath: { in: wanted }, inTrash: false },
    select: { relativePath: true },
  });
  const have = new Set(existing.map((e) => e.relativePath));
  for (const rel of wanted) {
    if (have.has(rel)) continue;
    let stat;
    try {
      stat = await fs.stat(path.join(MEDIA_ROOT, rel));
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    try {
      await tx.fileNode.create({
        data: {
          relativePath: rel,
          parentPath: parentOf(rel),
          name: baseName(rel),
          type: "DIRECTORY",
          modifiedAt: stat.mtime,
          isVisible: true,
        },
      });
      created.push(rel);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // someone else created it — fine
    }
  }
  return created;
}

/**
 * Create or refresh the live FileNode for a file Loom just wrote. Clears the
 * content identity when the content may have changed so derived media is
 * regenerated for the new bytes.
 */
export async function upsertFileNodeFromDisk(
  rel: string,
  opts: { contentIdentityId?: string | null; keepIdentity?: boolean } = {},
  tx: Tx = prisma
) {
  const abs = path.join(MEDIA_ROOT, rel);
  const stat = await fs.stat(abs);
  const isDir = stat.isDirectory();
  const data = {
    name: baseName(rel),
    parentPath: parentOf(rel),
    type: isDir ? ("DIRECTORY" as const) : ("FILE" as const),
    mimeType: isDir ? null : mimeTypeOf(rel),
    size: isDir ? null : BigInt(stat.size),
    modifiedAt: stat.mtime,
    sourceVersion: isDir ? null : sourceVersionOf(stat),
    isVisible: true,
  };
  const identity =
    opts.contentIdentityId !== undefined
      ? { contentIdentityId: opts.contentIdentityId }
      : opts.keepIdentity
        ? {}
        : { contentIdentityId: null };

  const existing = await tx.fileNode.findFirst({
    where: { relativePath: rel, inTrash: false },
    select: { id: true },
  });
  if (existing) {
    return tx.fileNode.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...identity,
        healthStatus: "HEALTHY",
        healthError: null,
        healthCheckedVersion: null,
        browserCompatible: opts.keepIdentity ? undefined : null,
      },
    });
  }
  try {
    return await tx.fileNode.create({
      data: { relativePath: rel, ...data, ...identity },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a race with the scanner indexing the same path — update instead.
    const row = await tx.fileNode.findFirstOrThrow({
      where: { relativePath: rel, inTrash: false },
      select: { id: true },
    });
    return tx.fileNode.update({ where: { id: row.id }, data: { ...data, ...identity } });
  }
}

/**
 * Rewrite every node under `oldRoot/` so it lives under `newRoot/` instead,
 * in one statement (relativePath and parentPath together). Optionally flips
 * inTrash for the whole subtree. The root node itself is not touched.
 */
export async function rewriteDescendantPaths(
  tx: Tx,
  oldRoot: string,
  newRoot: string,
  opts: { setInTrash?: boolean; fromTrash?: boolean } = {}
): Promise<number> {
  const pattern = likeEscape(oldRoot) + "/%";
  const cut = oldRoot.length + 1; // 1-based substr offset right after oldRoot
  const trashFilter = opts.fromTrash === undefined ? Prisma.empty : Prisma.sql`AND "inTrash" = ${opts.fromTrash}`;
  const setTrash =
    opts.setInTrash === undefined ? Prisma.empty : Prisma.sql`, "inTrash" = ${opts.setInTrash}`;
  return tx.$executeRaw`
    UPDATE "file_nodes"
    SET "relativePath" = ${newRoot} || substr("relativePath", ${cut}::int),
        "parentPath"   = ${newRoot} || substr("parentPath", ${cut}::int)
        ${setTrash},
        "updatedAt" = now()
    WHERE "relativePath" LIKE ${pattern} ESCAPE '\\' ${trashFilter}`;
}

/** Keep trash items restorable to the right place after an ancestor moves. */
export async function rewriteTrashOriginalPaths(tx: Tx, oldRoot: string, newRoot: string) {
  const pattern = likeEscape(oldRoot) + "/%";
  const cut = oldRoot.length + 1;
  await tx.$executeRaw`
    UPDATE "trash_items"
    SET "originalPath" = ${newRoot} || substr("originalPath", ${cut}::int)
    WHERE "originalPath" LIKE ${pattern} ESCAPE '\\'`;
}
