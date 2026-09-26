/**
 * GET  /api/favorites?cursor=&limit=  — the user's starred items
 * GET  /api/favorites?ids=1           — just the starred node ids (all of them)
 * POST /api/favorites { fileNodeId, favorite? } — toggle, or set explicitly
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { route, requireUser, readJson, intParam, badRequest, notFound, forbidden, toJson } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { nodeInclude, serializeListed } from "@/lib/listing";

export const GET = route(async (req) => {
  const user = await requireUser();
  const acl = await getAcl(user);
  const sp = req.nextUrl.searchParams;

  if (sp.get("ids") === "1") {
    const rows = await prisma.favorite.findMany({
      where: { userId: user.id, fileNode: { inTrash: false } },
      select: { fileNodeId: true, fileNode: { select: { relativePath: true } } },
    });
    return NextResponse.json({
      ids: rows.filter((r) => acl.canAccess(r.fileNode.relativePath)).map((r) => r.fileNodeId),
    });
  }

  const limit = intParam(sp.get("limit"), 100, 1, 500);
  const cursor = sp.get("cursor");
  const favorites = await prisma.favorite.findMany({
    where: { userId: user.id, fileNode: { inTrash: false } },
    include: { fileNode: { include: nodeInclude } },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });
  const hasMore = favorites.length > limit;
  const page = (hasMore ? favorites.slice(0, limit) : favorites).filter((f) => acl.canAccess(f.fileNode.relativePath));
  const nodes = await serializeListed(page.map((f) => f.fileNode));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return NextResponse.json({
    favorites: toJson(page.map((f) => ({ id: f.id, fileNodeId: f.fileNodeId, createdAt: f.createdAt, fileNode: byId.get(f.fileNodeId) }))),
    nextCursor: hasMore ? favorites[limit - 1].id : null,
  });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const { fileNodeId, favorite } = await readJson<{ fileNodeId?: string; favorite?: boolean }>(req);
  if (typeof fileNodeId !== "string") throw badRequest("fileNodeId is required");
  const node = await prisma.fileNode.findUnique({ where: { id: fileNodeId }, select: { relativePath: true, inTrash: true } });
  if (!node || node.inTrash) throw notFound();
  const acl = await getAcl(user);
  if (!acl.canAccess(node.relativePath)) throw forbidden();

  const key = { userId_fileNodeId: { userId: user.id, fileNodeId } };
  const existing = await prisma.favorite.findUnique({ where: key });
  const want = typeof favorite === "boolean" ? favorite : !existing;
  if (want && !existing) {
    try {
      await prisma.favorite.create({ data: { userId: user.id, fileNodeId } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
  } else if (!want && existing) {
    await prisma.favorite.deleteMany({ where: { userId: user.id, fileNodeId } });
  }
  return NextResponse.json({ favorited: want });
});
