/**
 * PATCH  /api/users/:id { name?, password?, role? } — Owner only
 * DELETE /api/users/:id                             — Owner only
 *
 * Guards: the last Owner can't be demoted or deleted, and changing a
 * password signs that user out everywhere.
 */
import { NextResponse } from "next/server";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";
import { route, requireOwner, readJson, badRequest, notFound } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const owner = await requireOwner();
  const { id } = await params;
  const { name, password, role } = await readJson<{ name?: unknown; password?: unknown; role?: unknown }>(req);

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw notFound("User not found");

  const data: { name?: string; role?: "OWNER" | "FAMILY"; password?: string } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw badRequest("Invalid name");
    data.name = name.trim();
  }
  if (role !== undefined) {
    if (role !== "OWNER" && role !== "FAMILY") throw badRequest("Role must be OWNER or FAMILY");
    if (target.role === "OWNER" && role === "FAMILY") {
      const owners = await prisma.user.count({ where: { role: "OWNER" } });
      if (owners <= 1) throw badRequest("There must always be at least one Owner");
    }
    data.role = role;
  }
  let newHash: string | undefined;
  if (password !== undefined && password !== "") {
    if (typeof password !== "string" || password.length < 8) throw badRequest("Password must be at least 8 characters");
    newHash = await hashPassword(password);
    data.password = newHash;
  }

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id }, data, select: { id: true, name: true, email: true, role: true } });
    if (newHash) {
      await tx.account.updateMany({ where: { userId: id, providerId: "credential" }, data: { password: newHash } });
      // Sign the user out everywhere (except the Owner's own current session
      // when they change their own password — they stay signed in here).
      if (id !== owner.id) await tx.session.deleteMany({ where: { userId: id } });
    }
    await tx.auditLog.create({
      data: {
        userId: owner.id,
        action: "USER_UPDATED",
        details: { targetId: id, targetEmail: target.email, changed: Object.keys(data) },
      },
    });
    return u;
  });
  return NextResponse.json({ user });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const owner = await requireOwner();
  const { id } = await params;
  if (id === owner.id) throw badRequest("You can't delete your own account");
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw notFound("User not found");
  if (target.role === "OWNER") {
    const owners = await prisma.user.count({ where: { role: "OWNER" } });
    if (owners <= 1) throw badRequest("There must always be at least one Owner");
  }
  // Sessions, accounts, ACL rules, favorites, uploads and notifications
  // cascade; trash items they deleted stay (deletedByUserId -> null).
  await prisma.$transaction([
    prisma.user.delete({ where: { id } }),
    prisma.auditLog.create({
      data: { userId: owner.id, action: "USER_DELETED", details: { targetId: id, targetEmail: target.email } },
    }),
  ]);
  return NextResponse.json({ success: true });
});
