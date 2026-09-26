/** GET /api/share/:token/zip?path= — download a shared folder (or part of it) as a ZIP. */
import { route, forbidden } from "@/lib/http";
import { requireUnlockedShare, sharedPath, recordShareAccess } from "@/lib/shares";
import { getAcl } from "@/lib/acl";
import { prisma } from "@/lib/prisma";
import { zipResponse } from "@/lib/zip";

export const GET = route<{ params: Promise<{ token: string }> }>(async (req, { params }) => {
  const { link, root } = await requireUnlockedShare((await params).token);
  if (!link.allowDownload) throw forbidden("Downloads are disabled for this link");
  const rel = sharedPath(root, new URL(req.url).searchParams.get("path"));
  const creator = await prisma.user.findUniqueOrThrow({ where: { id: link.createdById }, select: { id: true, role: true } });
  const acl = await getAcl(creator);
  await recordShareAccess(link.id);
  const name = rel.split("/").pop() || "Shared";
  return zipResponse([{ rel, nameInZip: name }], `${name}.zip`, (r, isDir) => (isDir ? acl.canTraverse(r) : acl.canAccess(r)));
});
