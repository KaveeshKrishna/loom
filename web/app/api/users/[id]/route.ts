import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
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
  const data: Record<string, string> = {};
  if (name) data.name = name;
  if (role) data.role = role;
  if (password) data.passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.update({
    where: { id }, data, select: { id: true, name: true, email: true, role: true },
  });
  await prisma.auditLog.create({ data: { userId: owner.id, action: "USER_UPDATED", details: { targetId: id } } });
  return NextResponse.json({ user });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  if (id === owner.id) return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  await prisma.user.delete({ where: { id } });
  await prisma.auditLog.create({ data: { userId: owner.id, action: "USER_DELETED", details: { targetId: id } } });
  return NextResponse.json({ success: true });
}
