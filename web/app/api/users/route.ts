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

export async function GET() {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { name, email, password, role } = await req.json();
  if (!name || !email || !password) {
    return NextResponse.json({ error: "name, email, and password are required" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }

  const hash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, password: hash, role: role === "OWNER" ? "OWNER" : "FAMILY" },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  await prisma.auditLog.create({
    data: { userId: owner.id, action: "USER_CREATED", details: { targetEmail: email } },
  });

  return NextResponse.json({ user });
}
