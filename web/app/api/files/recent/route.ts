/** GET /api/files/recent — most recently modified files (newest first). */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, intParam } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { nodeInclude, serializeListed } from "@/lib/listing";

export const GET = route(async (req) => {
  const user = await requireUser();
  const acl = await getAcl(user);
  const limit = intParam(req.nextUrl.searchParams.get("limit"), 100, 1, 500);
  const out = [];
  let skip = 0;
  // Page through until we have `limit` items the user may see.
  while (out.length < limit && skip < 20_000) {
    const batch = await prisma.fileNode.findMany({
      where: { isVisible: true, type: "FILE", inTrash: false, modifiedAt: { not: null } },
      include: nodeInclude,
      orderBy: { modifiedAt: "desc" },
      skip,
      take: 200,
    });
    if (batch.length === 0) break;
    skip += batch.length;
    for (const n of batch) if (acl.canAccess(n.relativePath)) out.push(n);
  }
  return NextResponse.json({ nodes: await serializeListed(out.slice(0, limit)) });
});
