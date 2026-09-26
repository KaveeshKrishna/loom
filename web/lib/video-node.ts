/** Shared checks for the video (HLS) routes. */
import { prisma } from "./prisma";
import { getAcl } from "./acl";
import { requireUser, forbidden, notFound, badRequest } from "./http";
import { resolveMediaPath } from "./fs-guard";
import { resolveAndLinkContentIdentity } from "./content-identity";

export async function loadVideoNode(fileNodeId: string) {
  const user = await requireUser();
  const node = await prisma.fileNode.findUnique({ where: { id: fileNodeId } });
  if (!node || node.inTrash) throw notFound();
  const acl = await getAcl(user);
  if (!acl.canAccess(node.relativePath)) throw forbidden();
  if (node.type !== "FILE" || !node.mimeType?.startsWith("video/")) throw badRequest("Not a video");
  const abs = await resolveMediaPath(node.relativePath, true);
  // HLS caches are keyed by content, so make sure the identity is known.
  const contentIdentityId = node.contentIdentityId ?? (await resolveAndLinkContentIdentity(abs, node.id));
  return { node, abs, contentIdentityId };
}
