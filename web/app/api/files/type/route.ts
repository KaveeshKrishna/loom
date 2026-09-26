/**
 * GET /api/files/type?type=image|video|audio|document&cursor=&limit=
 * Library-wide category views, newest first, paginated by cursor.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, intParam } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { categoryWhere } from "@/lib/categories";
import { nodeInclude, serializeListed, type ListedNode } from "@/lib/listing";

export const GET = route(async (req) => {
  const user = await requireUser();
  const { searchParams } = req.nextUrl;
  const where = categoryWhere(searchParams.get("type") ?? "");
  if (!where || searchParams.get("type") === "folder") return NextResponse.json({ nodes: [], nextCursor: null });
  const limit = intParam(searchParams.get("limit"), 100, 1, 500);
  let cursor = searchParams.get("cursor");
  const acl = await getAcl(user);

  const out: ListedNode[] = [];
  let exhausted = false;
  // Keep scanning until the page is full of items this user may see, so
  // permission filtering never ends infinite scroll early.
  for (let rounds = 0; out.length < limit && rounds < 20; rounds++) {
    const batch = await prisma.fileNode.findMany({
      where: { ...where, isVisible: true, inTrash: false },
      include: nodeInclude,
      orderBy: [{ modifiedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    for (const n of batch) {
      if (out.length >= limit) break;
      cursor = n.id;
      if (acl.canAccess(n.relativePath)) out.push(n);
    }
    if (batch.length < limit) {
      exhausted = true;
      break;
    }
  }
  return NextResponse.json({ nodes: await serializeListed(out), nextCursor: exhausted ? null : cursor });
});
