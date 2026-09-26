/**
 * Owner-only management of Family users' folder rules.
 * GET    /api/acl?userId=
 * POST   /api/acl { userId, path, allow, id? }  — create/update (id = edit an existing rule)
 * DELETE /api/acl { id }
 * A rule on "" or "/" is the root rule and applies to everything.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireOwner, readJson, badRequest, notFound } from "@/lib/http";
import { normalizeAclPath } from "@/lib/acl";

export const GET = route(async (req) => {
  await requireOwner();
  const userId = req.nextUrl.searchParams.get("userId");
  const rules = await prisma.aclRule.findMany({
    where: userId ? { userId } : undefined,
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ userId: "asc" }, { path: "asc" }],
  });
  return NextResponse.json({ rules });
});

export const POST = route(async (req) => {
  const owner = await requireOwner();
  const { userId, path, allow, id } = await readJson<Record<string, unknown>>(req);
  if (typeof userId !== "string" || typeof path !== "string" || typeof allow !== "boolean") {
    throw badRequest("userId, path, and allow are required");
  }
  if (path.split("/").includes("..")) throw badRequest("Invalid path");
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target) throw notFound("User not found");
  const normalized = normalizeAclPath(path);

  const rule = await prisma.$transaction(async (tx) => {
    if (typeof id === "string") {
      // Editing: remove the old rule so changing its path doesn't leave it behind.
      await tx.aclRule.deleteMany({ where: { id, userId } });
    }
    return tx.aclRule.upsert({
      where: { userId_path: { userId, path: normalized } },
      update: { allow },
      create: { userId, path: normalized, allow },
    });
  });
  await prisma.auditLog.create({
    data: { userId: owner.id, action: "ACL_CHANGED", details: { targetId: userId, path: normalized, allow } },
  });
  return NextResponse.json({ rule });
});

export const DELETE = route(async (req) => {
  const owner = await requireOwner();
  const { id } = await readJson<{ id?: string }>(req);
  if (typeof id !== "string") throw badRequest("id is required");
  const rule = await prisma.aclRule.findUnique({ where: { id } });
  if (!rule) throw notFound("Rule not found");
  await prisma.aclRule.delete({ where: { id } });
  await prisma.auditLog.create({
    data: { userId: owner.id, action: "ACL_REMOVED", details: { targetId: rule.userId, path: rule.path } },
  });
  return NextResponse.json({ success: true });
});
