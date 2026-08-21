import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";

async function requireOwner() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") return null;
  return user;
}

export async function GET(req: NextRequest) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const userId = req.nextUrl.searchParams.get("userId");
  const rules = await prisma.aclRule.findMany({
    where: userId ? { userId } : undefined,
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ userId: "asc" }, { path: "asc" }],
  });

  return NextResponse.json({ rules });
}

export async function POST(req: NextRequest) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { userId, path, allow } = await req.json();
  if (!userId || !path || typeof allow !== "boolean") {
    return NextResponse.json({ error: "userId, path, and allow are required" }, { status: 400 });
  }

  const rule = await prisma.aclRule.upsert({
    where: { userId_path: { userId, path } },
    update: { allow },
    create: { userId, path, allow },
  });

  return NextResponse.json({ rule });
}

export async function DELETE(req: NextRequest) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await req.json();
  await prisma.aclRule.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
