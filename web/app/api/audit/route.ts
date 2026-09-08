import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";

const MAX_AUDIT_LOGS = 20;

async function pruneOldLogs() {
  // Keep only the latest MAX_AUDIT_LOGS, delete the rest
  const all = await prisma.auditLog.findMany({
    orderBy: { timestamp: "desc" },
    select: { id: true },
  });
  if (all.length > MAX_AUDIT_LOGS) {
    const toDelete = all.slice(MAX_AUDIT_LOGS).map((l) => l.id);
    await prisma.auditLog.deleteMany({ where: { id: { in: toDelete } } });
  }
}

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Auto-prune on every read
  await pruneOldLogs();

  const logs = await prisma.auditLog.findMany({
    include: { user: { select: { name: true, email: true } } },
    orderBy: { timestamp: "desc" },
    take: MAX_AUDIT_LOGS,
  });
  return NextResponse.json({ logs });
}

export async function DELETE(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");

  if (id) {
    // Delete a single log entry
    await prisma.auditLog.delete({ where: { id } }).catch(() => {});
    return NextResponse.json({ success: true });
  } else {
    // Clear all log entries
    await prisma.auditLog.deleteMany({});
    return NextResponse.json({ success: true });
  }
}
