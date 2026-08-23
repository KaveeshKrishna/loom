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

  // Use Better Auth's own hashPassword so the hash format matches what
  // Better Auth's verifyPassword expects during sign-in.
  const hash = await hashPassword(password);

  const user = await prisma.user.create({
    data: { name, email, password: hash, role: role === "OWNER" ? "OWNER" : "FAMILY" },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  // Create the credential account row that Better Auth looks up on sign-in.
  await prisma.account.create({
    data: {
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password: hash,
    },
  });

  await prisma.auditLog.create({
    data: { userId: owner.id, action: "USER_CREATED", details: { targetEmail: email } },
  });

  return NextResponse.json({ user });
}
