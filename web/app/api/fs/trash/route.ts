/**
 * GET    /api/fs/trash           — list trash (Owner: everything, Family: own items)
 * POST   /api/fs/trash {paths}   — move items to Trash
 * DELETE /api/fs/trash           — empty trash (Owner: all, Family: own items)
 */
import { NextResponse } from "next/server";
import { route, requireUser, readJson, badRequest, toJson } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { prisma } from "@/lib/prisma";
import { trashItem, emptyTrash } from "@/lib/file-ops";

export const GET = route(async () => {
  const user = await requireUser();
  const trashItems = await prisma.trashItem.findMany({
    where: user.role === "OWNER" ? undefined : { deletedByUserId: user.id },
    include: { fileNode: true, user: { select: { name: true } } },
    orderBy: { deletedAt: "desc" },
    take: 5000,
  });

  // Folder sizes in one grouped query instead of one query per folder.
  const dirRoots = trashItems.filter((t) => t.fileNode.type === "DIRECTORY").map((t) => `.LoomTrash/${t.trashPath}`);
  if (dirRoots.length > 0) {
    const sizes = await prisma.$queryRaw<{ root: string; size: bigint }[]>`
      SELECT split_part("relativePath", '/', 1) || '/' || split_part("relativePath", '/', 2) AS root,
             COALESCE(SUM("size"), 0)::bigint AS size
      FROM "file_nodes"
      WHERE "inTrash" = true AND "type" = 'FILE' AND "relativePath" LIKE '.LoomTrash/%/%'
      GROUP BY 1`;
    const byRoot = new Map(sizes.map((s) => [s.root, s.size]));
    for (const item of trashItems) {
      if (item.fileNode.type === "DIRECTORY") {
        item.fileNode.size = byRoot.get(`.LoomTrash/${item.trashPath}`) ?? BigInt(0);
      }
    }
  }
  return NextResponse.json(toJson({ trashItems }));
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const { paths } = await readJson<{ paths?: unknown }>(req);
  if (!Array.isArray(paths) || paths.length === 0) throw badRequest("No paths provided");
  const acl = await getAcl(user);
  const results = [];
  for (const p of paths.slice(0, 5000)) results.push(await trashItem(user, acl, String(p)));
  return NextResponse.json({ results });
});

export const DELETE = route(async () => {
  const user = await requireUser();
  const result = await emptyTrash(user);
  return NextResponse.json({ success: true, ...result });
});
