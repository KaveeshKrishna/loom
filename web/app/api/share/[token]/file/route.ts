/**
 * GET /api/share/:token/file?path=&download=1 — a shared file (or a file inside a
 * shared folder). download=1 is refused when the link doesn't allow downloads.
 */
import { route, forbidden, badRequest } from "@/lib/http";
import { requireUnlockedShare, sharedPath, recordShareAccess } from "@/lib/shares";
import { resolveMediaPath, baseName } from "@/lib/fs-guard";
import { sendFile } from "@/lib/send-file";
import { prisma } from "@/lib/prisma";

async function handle(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { link, root } = await requireUnlockedShare((await params).token);
  const url = new URL(req.url);
  const rel = sharedPath(root, url.searchParams.get("path"));
  const node = await prisma.fileNode.findFirst({ where: { relativePath: rel, inTrash: false }, select: { type: true } });
  if (!node || node.type !== "FILE") throw badRequest("Not a file");
  const download = url.searchParams.get("download") === "1";
  if (download && !link.allowDownload) throw forbidden("Downloads are disabled for this link");
  if (rel === root.relativePath && !req.headers.get("range")) await recordShareAccess(link.id);
  const abs = await resolveMediaPath(rel, true);
  return sendFile(req, abs, { filename: baseName(rel), download, cacheControl: "private, no-cache" });
}

export const GET = route(handle);
export const HEAD = route(handle);
