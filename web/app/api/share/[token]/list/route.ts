/** GET /api/share/:token/list?path= — contents of a shared folder (or a sub-folder of it). */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, notFound, toJson } from "@/lib/http";
import { requireUnlockedShare, sharedPath, relativeToShare, recordShareAccess } from "@/lib/shares";

export const GET = route<{ params: Promise<{ token: string }> }>(async (req, { params }) => {
  const { link, root } = await requireUnlockedShare((await params).token);
  const dir = sharedPath(root, req.nextUrl.searchParams.get("path"));
  if (root.type !== "DIRECTORY") throw notFound();
  if (dir !== root.relativePath) {
    const d = await prisma.fileNode.findFirst({ where: { relativePath: dir, inTrash: false, type: "DIRECTORY" } });
    if (!d) throw notFound("Folder not found");
  }
  const children = await prisma.fileNode.findMany({
    where: { parentPath: dir, inTrash: false, isVisible: true },
    select: {
      id: true, name: true, type: true, mimeType: true, size: true, modifiedAt: true, relativePath: true,
      contentIdentity: { select: { thumbnail: { select: { cachePath: true } } } },
    },
    take: 20_000,
  });
  if (dir === root.relativePath) await recordShareAccess(link.id);
  return NextResponse.json(
    toJson({
      path: relativeToShare(root, dir),
      allowDownload: link.allowDownload,
      children: children.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        mimeType: c.mimeType,
        size: c.size,
        modifiedAt: c.modifiedAt,
        path: relativeToShare(root, c.relativePath),
        hasThumb: !!c.contentIdentity?.thumbnail,
      })),
    }),
    { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } }
  );
});
