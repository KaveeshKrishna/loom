/**
 * cache-access.ts — serve files from /cache (thumbnails, previews) only to
 * users allowed to see at least one file with that content.
 */
import path from "path";
import { prisma } from "./prisma";
import type { AclEvaluator } from "./acl";
import { forbidden, notFound, badRequest } from "./http";

export const CACHE_ROOT = process.env.CACHE_ROOT ?? "/cache";

/** Extract the ContentIdentity id from a cache-relative path. */
export function contentIdFromCachePath(rel: string): string | null {
  const m =
    /^(?:thumbnails|previews)\/(?:video-)?([a-z0-9]+)_[a-z0-9]+\.[a-z0-9]+$/i.exec(rel) ??
    /^videos\/([a-z0-9]+)\//i.exec(rel);
  return m ? m[1] : null;
}

/** Validate a cache path and return its absolute location. */
export async function resolveCachePath(rawSegments: string[], acl: AclEvaluator): Promise<string> {
  const rel = rawSegments.filter((s) => s && s !== ".").join("/");
  if (!rel || rel.split("/").includes("..")) throw badRequest("Invalid path");
  const abs = path.join(CACHE_ROOT, rel);
  if (!abs.startsWith(CACHE_ROOT + path.sep)) throw badRequest("Invalid path");

  if (!acl.isOwner) {
    const ciId = contentIdFromCachePath(rel);
    if (!ciId) throw forbidden();
    const nodes = await prisma.fileNode.findMany({
      where: { contentIdentityId: ciId, inTrash: false },
      select: { relativePath: true },
      take: 200,
    });
    if (nodes.length === 0) throw notFound();
    if (!nodes.some((n) => acl.canAccess(n.relativePath))) throw forbidden();
  }
  return abs;
}
