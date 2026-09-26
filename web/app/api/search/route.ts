/**
 * GET /api/search?q=...&folder=...&type=image|video|audio|document|folder
 * Name search backed by a trigram index. Results are ranked exact match
 * first, then prefix matches, then by similarity; permissions are applied
 * before the result limit so Family users still get a full page.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { route, requireUser, intParam } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { normalizeRelPath, likeEscape } from "@/lib/fs-guard";
import { nodeInclude, serializeListed } from "@/lib/listing";

const TYPE_SQL: Record<string, Prisma.Sql> = {
  image: Prisma.sql`AND "type" = 'FILE' AND "mimeType" LIKE 'image/%'`,
  video: Prisma.sql`AND "type" = 'FILE' AND "mimeType" LIKE 'video/%'`,
  audio: Prisma.sql`AND "type" = 'FILE' AND "mimeType" LIKE 'audio/%'`,
  document: Prisma.sql`AND "type" = 'FILE' AND ("mimeType" LIKE 'text/%' OR "mimeType" ~ '(pdf|msword|officedocument|opendocument|ms-excel|ms-powerpoint|rtf|epub|json)')`,
  folder: Prisma.sql`AND "type" = 'DIRECTORY'`,
};

export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  if (!q) return NextResponse.json({ results: [] });
  const folder = normalizeRelPath(sp.get("folder"));
  const limit = intParam(sp.get("limit"), 50, 1, 200);
  const acl = await getAcl(user);

  const pattern = "%" + likeEscape(q) + "%";
  const folderSql = folder ? Prisma.sql`AND "relativePath" LIKE ${likeEscape(folder) + "/%"} ESCAPE '\\'` : Prisma.empty;
  const typeSql = TYPE_SQL[sp.get("type") ?? ""] ?? Prisma.empty;

  const ids: string[] = [];
  for (let offset = 0; ids.length < limit && offset < 5000; offset += 250) {
    const rows = await prisma.$queryRaw<{ id: string; relativePath: string }[]>`
      SELECT id, "relativePath" FROM "file_nodes"
      WHERE "inTrash" = false AND "isVisible" = true
        AND "name" ILIKE ${pattern} ESCAPE '\\' ${folderSql} ${typeSql}
      ORDER BY (lower("name") = lower(${q})) DESC,
               (lower("name") LIKE lower(${likeEscape(q) + "%"}) ESCAPE '\\') DESC,
               similarity("name", ${q}) DESC,
               length("name") ASC
      LIMIT 250 OFFSET ${offset}`;
    for (const r of rows) {
      if (ids.length >= limit) break;
      if (acl.canAccess(r.relativePath)) ids.push(r.id);
    }
    if (rows.length < 250) break;
  }

  const nodes = await prisma.fileNode.findMany({ where: { id: { in: ids } }, include: nodeInclude });
  const order = new Map(ids.map((id, i) => [id, i]));
  nodes.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return NextResponse.json({ results: await serializeListed(nodes) });
});
