/**
 * Owner-only scanner controls.
 * POST   /api/scan         — queue a full rescan (reuses one already queued/running)
 * GET    /api/scan         — recent rescans, background-queue stats, scanner status
 * DELETE /api/scan?id=     — cancel a queued/running job, or delete a finished one;
 *                            without id, clear finished rescans from the list
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireOwner, notFound } from "@/lib/http";
import { notifyScanner } from "@/lib/jobs";

export const POST = route(async () => {
  const owner = await requireOwner();
  const existing = await prisma.scanJob.findFirst({
    where: { type: "FULL_RESCAN", status: { in: ["PENDING", "RUNNING"] } },
  });
  if (existing) return NextResponse.json({ job: existing, alreadyQueued: true });
  const job = await prisma.scanJob.create({
    data: { type: "FULL_RESCAN", status: "PENDING", requestedBy: owner.id },
  });
  await prisma.auditLog.create({ data: { userId: owner.id, action: "RESCAN_REQUESTED", details: {} } });
  await notifyScanner();
  return NextResponse.json({ job });
});

export const GET = route(async () => {
  await requireOwner();
  const [jobs, queue, failedRecent, status, heartbeat] = await Promise.all([
    prisma.scanJob.findMany({
      where: { type: { in: ["FULL_RESCAN", "INDEX_FILE"] } },
      orderBy: { requestedAt: "desc" },
      take: 10,
    }),
    prisma.scanJob.groupBy({
      by: ["status"],
      where: { type: "PROCESS_FILE", status: { in: ["PENDING", "RUNNING"] } },
      _count: { _all: true },
    }),
    prisma.scanJob.count({
      where: { type: "PROCESS_FILE", status: "FAILED", completedAt: { gt: new Date(Date.now() - 86_400_000) } },
    }),
    prisma.systemStatus.findUnique({ where: { key: "scanner_status" } }),
    prisma.systemStatus.findUnique({ where: { key: "scanner_heartbeat" } }),
  ]);
  const count = (s: string) => queue.find((q) => q.status === s)?._count._all ?? 0;
  const lastBeat = heartbeat ? new Date(heartbeat.value).getTime() : 0;
  return NextResponse.json({
    jobs,
    scannerStatus: status?.value ?? "idle",
    scannerOnline: Date.now() - lastBeat < 90_000,
    processing: { pending: count("PENDING"), running: count("RUNNING"), failedLast24h: failedRecent },
  });
});

export const DELETE = route(async (req) => {
  await requireOwner();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    await prisma.scanJob.deleteMany({
      where: { type: { in: ["FULL_RESCAN", "INDEX_FILE"] }, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
    });
    return NextResponse.json({ success: true });
  }
  const job = await prisma.scanJob.findUnique({ where: { id } });
  if (!job) throw notFound();
  if (job.status === "RUNNING" || job.status === "PENDING") {
    await prisma.scanJob.update({ where: { id }, data: { status: "CANCELLED", completedAt: new Date() } });
  } else {
    await prisma.scanJob.delete({ where: { id } });
  }
  return NextResponse.json({ success: true });
});
