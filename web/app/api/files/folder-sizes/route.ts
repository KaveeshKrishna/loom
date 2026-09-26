/**
 * GET /api/files/folder-sizes?path=... — total size and file count of every
 * sub-folder of `path`, in one grouped query (instead of one request per
 * folder tile).
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { route, requireUser, forbidden } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { normalizeRelPath, likeEscape } from "@/lib/fs-guard";

export const GET = route(async (req) => {
  const user = await requireUser();
  const path = normalizeRelPath(req.nextUrl.searchParams.get("path"));
  const acl = await getAcl(user);
  if (!acl.canTraverse(path)) throw forbidden();

  const prefix = path ? path + "/" : "";
  const cut = prefix.length + 1;
  const like = path ? Prisma.sql`AND "relativePath" LIKE ${likeEscape(path) + "/%/%"} ESCAPE '\\'` : Prisma.sql`AND "relativePath" LIKE '%/%' AND "relativePath" NOT LIKE '.LoomTrash/%'`;
  const rows = await prisma.$queryRaw<{ child: string; size: bigint; files: bigint }[]>`
    SELECT split_part(substr("relativePath", ${cut}::int), '/', 1) AS child,
           COALESCE(SUM("size"), 0)::bigint AS size,
           COUNT(*) AS files
    FROM "file_nodes"
    WHERE "inTrash" = false AND "isVisible" = true AND "type" = 'FILE' ${like}
    GROUP BY 1`;
  const sizes: Record<string, { size: string; files: number }> = {};
  for (const r of rows) {
    const rel = prefix + r.child;
    if (acl.canTraverse(rel)) sizes[r.child] = { size: r.size.toString(), files: Number(r.files) };
  }
  return NextResponse.json({ path, sizes }, { headers: { "Cache-Control": "private, max-age=15" } });
});
