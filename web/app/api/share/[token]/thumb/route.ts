/** GET /api/share/:token/thumb?path= — thumbnail of a shared image/video. */
import path from "path";
import { route, notFound } from "@/lib/http";
import { requireUnlockedShare, sharedPath } from "@/lib/shares";
import { sendFile } from "@/lib/send-file";
import { prisma } from "@/lib/prisma";
import { CACHE_ROOT } from "@/lib/cache-access";

export const GET = route<{ params: Promise<{ token: string }> }>(async (req, { params }) => {
  const { root } = await requireUnlockedShare((await params).token);
  const rel = sharedPath(root, new URL(req.url).searchParams.get("path"));
  const node = await prisma.fileNode.findFirst({
    where: { relativePath: rel, inTrash: false },
    select: { contentIdentity: { select: { thumbnail: { select: { cachePath: true } }, preview: { select: { cachePath: true } } } } },
  });
  const size = new URL(req.url).searchParams.get("size");
  const cp = size === "preview" ? node?.contentIdentity?.preview?.cachePath ?? node?.contentIdentity?.thumbnail?.cachePath : node?.contentIdentity?.thumbnail?.cachePath;
  if (!cp) throw notFound();
  const abs = path.join(CACHE_ROOT, cp);
  if (!abs.startsWith(CACHE_ROOT + path.sep)) throw notFound();
  return sendFile(req, abs, { filename: path.basename(cp), cacheControl: "private, max-age=3600" });
});
