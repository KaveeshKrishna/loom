/**
 * GET    /api/audit?cursor=&limit=&action=  — audit log, newest first (Owner only)
 * DELETE /api/audit?id=  — delete one entry; without id, clear everything
 *
 * Reading never deletes anything. Old entries are pruned by the scanner after
 * LOOM_AUDIT_RETENTION_DAYS (default 180).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireOwner, intParam } from "@/lib/http";

export const GET = route(async (req) => {
  await requireOwner();
  const sp = req.nextUrl.searchParams;
  const limit = intParam(sp.get("limit"), 50, 1, 200);
  const cursor = sp.get("cursor");
  const action = sp.get("action");
  const logs = await prisma.auditLog.findMany({
    where: action ? { action } : undefined,
    include: { user: { select: { name: true, email: true } } },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });
  const hasMore = logs.length > limit;
  const page = hasMore ? logs.slice(0, limit) : logs;
  return NextResponse.json({ logs: page, nextCursor: hasMore ? page[page.length - 1].id : null });
});

export const DELETE = route(async (req) => {
  const owner = await requireOwner();
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    await prisma.auditLog.deleteMany({ where: { id } });
  } else {
    await prisma.auditLog.deleteMany({});
    await prisma.auditLog.create({ data: { userId: owner.id, action: "AUDIT_CLEARED", details: {} } });
  }
  return NextResponse.json({ success: true });
});
