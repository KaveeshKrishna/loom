import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "better-auth/crypto";
import { headers } from "next/headers";

async function requireOwner() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") return null;
  return user;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const { name, password, role } = await req.json();

  const userUpdate: Record<string, string> = {};
  if (name) userUpdate.name = name;
  if (role) userUpdate.role = role;

  let newHash: string | undefined;
  if (password) {
    // Use Better Auth's hashPassword so the credential account stays valid for sign-in
    newHash = await hashPassword(password);
    userUpdate.password = newHash;
  }

  const user = await prisma.user.update({
    where: { id },
    data: userUpdate,
    select: { id: true, name: true, email: true, role: true },
  });

  // Keep the Better Auth credential account password in sync
  if (newHash) {
    await prisma.account.updateMany({
      where: { userId: id, providerId: "credential" },
      data: { password: newHash },
    });
  }

  await prisma.auditLog.create({
    data: { userId: owner.id, action: "USER_UPDATED", details: { targetId: id } },
  });
  return NextResponse.json({ user });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  if (id === owner.id) return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });

  // AclRule has onDelete: Cascade in the Prisma schema so ACL rules are
  // automatically removed. We delete sessions and accounts manually first to
  // avoid any FK ordering issues across providers.
  await prisma.session.deleteMany({ where: { userId: id } });
  await prisma.account.deleteMany({ where: { userId: id } });
  await prisma.aclRule.deleteMany({ where: { userId: id } });
  await prisma.user.delete({ where: { id } });

  await prisma.auditLog.create({
    data: { userId: owner.id, action: "USER_DELETED", details: { targetId: id } },
  });
  return NextResponse.json({ success: true });
}
