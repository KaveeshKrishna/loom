/**
 * PATCH  /api/shares/:id { expiresInDays?, password?, allowDownload?, revoke? }
 * DELETE /api/shares/:id   — delete the link (it stops working immediately)
 * Only the link's creator or the Owner.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, readJson, badRequest, forbidden, notFound } from "@/lib/http";
import { hashSharePassword } from "@/lib/shares";

type Ctx = { params: Promise<{ id: string }> };

async function own(id: string) {
  const user = await requireUser();
  const link = await prisma.shareLink.findUnique({ where: { id }, include: { fileNode: { select: { relativePath: true } } } });
  if (!link) throw notFound("Link not found");
  if (user.role !== "OWNER" && link.createdById !== user.id) throw forbidden();
  return { user, link };
}

export const PATCH = route<Ctx>(async (req, { params }) => {
  const { user, link } = await own((await params).id);
  const body = await readJson<{ expiresInDays?: unknown; password?: unknown; allowDownload?: unknown; revoke?: unknown }>(req);
  const data: { expiresAt?: Date | null; passwordHash?: string | null; allowDownload?: boolean; revokedAt?: Date | null } = {};
  if (body.expiresInDays !== undefined) {
    if (body.expiresInDays === null || body.expiresInDays === "") data.expiresAt = null;
    else {
      const days = Number(body.expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) throw badRequest("Invalid expiry");
      data.expiresAt = new Date(Date.now() + days * 86_400_000);
    }
  }
  if (body.password !== undefined) {
    if (body.password === null || body.password === "") data.passwordHash = null;
    else if (typeof body.password === "string" && body.password.length >= 4 && body.password.length <= 200) data.passwordHash = await hashSharePassword(body.password);
    else throw badRequest("Password must be 4–200 characters");
  }
  if (typeof body.allowDownload === "boolean") data.allowDownload = body.allowDownload;
  if (body.revoke === true) data.revokedAt = new Date();
  await prisma.shareLink.update({ where: { id: link.id }, data });
  await prisma.auditLog.create({
    data: { userId: user.id, action: body.revoke ? "SHARE_REVOKED" : "SHARE_UPDATED", details: { path: link.fileNode.relativePath, linkId: link.id } },
  });
  return NextResponse.json({ success: true });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { user, link } = await own((await params).id);
  await prisma.shareLink.delete({ where: { id: link.id } });
  await prisma.auditLog.create({ data: { userId: user.id, action: "SHARE_DELETED", details: { path: link.fileNode.relativePath, linkId: link.id } } });
  return NextResponse.json({ success: true });
});
