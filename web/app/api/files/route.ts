/**
 * GET /api/files?path=... — the direct children of a folder.
 * One indexed lookup on parentPath; permissions are evaluated in memory.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, forbidden, notFound } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { normalizeRelPath } from "@/lib/fs-guard";
import { nodeInclude, serializeListed } from "@/lib/listing";

export const GET = route(async (req) => {
  const user = await requireUser();
  const path = normalizeRelPath(req.nextUrl.searchParams.get("path"));
  const acl = await getAcl(user);
  if (!acl.canTraverse(path)) throw forbidden();

  if (path) {
    const dir = await prisma.fileNode.findFirst({
      where: { relativePath: path, inTrash: false },
      select: { type: true },
    });
    if (!dir) throw notFound("Folder not found");
    if (dir.type !== "DIRECTORY") throw notFound("Not a folder");
  }

  const children = await prisma.fileNode.findMany({
    where: { parentPath: path, inTrash: false, isVisible: true },
    include: nodeInclude,
    take: 50_000,
  });
  const visible = acl.isOwner ? children : children.filter((n) => acl.canTraverse(n.relativePath));
  return NextResponse.json({ path, children: await serializeListed(visible), canWrite: acl.canAccess(path) });
});
