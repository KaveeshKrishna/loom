/**
 * GET /api/files/properties?path=... — details for the Properties/Details panel:
 * size (recursive for folders), dates, type, health, media metadata (EXIF,
 * video codec/duration) and recent activity on this path.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, forbidden, notFound, toJson } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { normalizeRelPath } from "@/lib/fs-guard";
import { folderStats } from "@/lib/file-ops";

export const GET = route(async (req) => {
  const user = await requireUser();
  const path = normalizeRelPath(req.nextUrl.searchParams.get("path"));
  const acl = await getAcl(user);
  if (!acl.canTraverse(path)) throw forbidden();

  const node = await prisma.fileNode.findFirst({
    where: { relativePath: path, inTrash: false },
    include: { contentIdentity: { include: { videoCaches: true, thumbnail: true, preview: true } } },
  });
  if (!node) throw notFound();

  let size = node.size ?? BigInt(0);
  let childCount: number | undefined;
  let fileCount: number | undefined;
  let dirCount: number | undefined;
  if (node.type === "DIRECTORY") {
    const stats = await folderStats(node.relativePath);
    size = stats.size;
    fileCount = stats.files;
    dirCount = stats.dirs;
    childCount = stats.files + stats.dirs;
  }

  const favorite = await prisma.favorite.findUnique({
    where: { userId_fileNodeId: { userId: user.id, fileNodeId: node.id } },
    select: { id: true },
  });

  // Recent activity for this exact path (audit details are JSON)
  const activity = await prisma.$queryRaw<{ action: string; timestamp: Date; userName: string | null }[]>`
    SELECT a.action, a.timestamp, u.name AS "userName"
    FROM "audit_logs" a LEFT JOIN "users" u ON u.id = a."userId"
    WHERE a.details->>'path' = ${node.relativePath}
       OR a.details->>'dest' = ${node.relativePath}
       OR a.details->>'finalPath' = ${node.relativePath}
    ORDER BY a.timestamp DESC LIMIT 10`;

  const video = node.contentIdentity?.videoCaches?.[0];
  return NextResponse.json(
    toJson({
      id: node.id,
      name: node.name,
      type: node.type,
      mimeType: node.mimeType,
      relativePath: node.relativePath,
      size: size.toString(),
      childCount,
      fileCount,
      dirCount,
      modifiedAt: node.modifiedAt,
      indexedAt: node.indexedAt,
      healthStatus: node.healthStatus,
      healthError: node.healthError,
      fastHash: node.contentIdentity?.fastHash,
      mediaInfo: node.contentIdentity?.mediaInfo ?? null,
      browserCompatible: node.browserCompatible,
      favorite: !!favorite,
      canWrite: acl.canAccess(node.relativePath),
      videoDetails: video ? { duration: video.durationSeconds ?? 0 } : null,
      activity,
    })
  );
});
