/**
 * GET  /api/shares?fileNodeId=   — links for one item (yours; the Owner sees everyone's)
 * GET  /api/shares               — your links (Owner: add ?all=1 for everyone's)
 * POST /api/shares { fileNodeId, expiresInDays?, password?, allowDownload? } — create a link
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, requireBrowserUser, readJson, badRequest, forbidden, notFound, HttpError } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { isSharingEnabled, newToken, hashToken, encryptToken, decryptToken, hashSharePassword, shareUrl } from "@/lib/shares";

type LinkRow = Awaited<ReturnType<typeof listQuery>>[number];

function listQuery(where: object) {
  return prisma.shareLink.findMany({
    where,
    include: {
      fileNode: { select: { id: true, name: true, relativePath: true, type: true, inTrash: true } },
      createdBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
}

function serializeLink(l: LinkRow) {
  const token = decryptToken(l.tokenEnc);
  const now = new Date();
  return {
    id: l.id,
    url: token ? shareUrl(token) : null,
    fileNode: l.fileNode,
    createdBy: l.createdBy,
    hasPassword: !!l.passwordHash,
    allowDownload: l.allowDownload,
    expiresAt: l.expiresAt,
    revokedAt: l.revokedAt,
    createdAt: l.createdAt,
    lastAccessedAt: l.lastAccessedAt,
    accessCount: l.accessCount,
    active: !l.revokedAt && (!l.expiresAt || l.expiresAt > now) && !l.fileNode.inTrash,
  };
}

export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;
  const fileNodeId = sp.get("fileNodeId");
  const everyone = user.role === "OWNER" && (sp.get("all") === "1" || !!fileNodeId);
  const where = {
    ...(fileNodeId ? { fileNodeId } : {}),
    ...(everyone ? {} : { createdById: user.id }),
  };
  const links = await listQuery(where);
  return NextResponse.json({ enabled: await isSharingEnabled(), links: links.map(serializeLink) });
});

export const POST = route(async (req) => {
  // Public links are created from a browser session, not with an app's token.
  const user = await requireBrowserUser();
  if (!(await isSharingEnabled())) throw new HttpError(403, "Share links are turned off. The Owner can enable them in Settings → Sharing.");
  const body = await readJson<{ fileNodeId?: string; expiresInDays?: unknown; password?: unknown; allowDownload?: unknown }>(req);
  if (typeof body.fileNodeId !== "string") throw badRequest("fileNodeId is required");
  const node = await prisma.fileNode.findUnique({ where: { id: body.fileNodeId } });
  if (!node || node.inTrash) throw notFound();
  const acl = await getAcl(user);
  if (!acl.canAccessTree(node.relativePath)) throw forbidden("You can only share items you (and everything inside them) can access");

  let expiresAt: Date | null = null;
  if (body.expiresInDays != null && body.expiresInDays !== "") {
    const days = Number(body.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) throw badRequest("Invalid expiry");
    expiresAt = new Date(Date.now() + days * 86_400_000);
  }
  let passwordHash: string | null = null;
  if (typeof body.password === "string" && body.password.length > 0) {
    if (body.password.length < 4 || body.password.length > 200) throw badRequest("Password must be 4–200 characters");
    passwordHash = await hashSharePassword(body.password);
  }

  const token = newToken();
  const link = await prisma.shareLink.create({
    data: {
      tokenHash: hashToken(token),
      tokenEnc: encryptToken(token),
      fileNodeId: node.id,
      createdById: user.id,
      passwordHash,
      expiresAt,
      allowDownload: body.allowDownload !== false,
    },
  });
  await prisma.auditLog.create({
    data: { userId: user.id, action: "SHARE_CREATED", details: { path: node.relativePath, linkId: link.id, expiresAt, password: !!passwordHash } },
  });
  const [row] = await listQuery({ id: link.id });
  return NextResponse.json({ link: { ...serializeLink(row), url: shareUrl(token) } }, { status: 201 });
});
