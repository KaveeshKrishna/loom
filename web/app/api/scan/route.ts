import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";

export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Only FULL_RESCAN is Owner-triggerable. INDEX_FILE is created by the
  // upload pipeline after a successful atomic file move to /media.
  const job = await prisma.scanJob.create({
    data: {
      type: "FULL_RESCAN",
      status: "PENDING",
      requestedBy: user.id,
    },
  });

  return NextResponse.json({ job });
}

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Cleanup: Keep only the 10 most recent logs
  const keepJobs = await prisma.scanJob.findMany({
    orderBy: { requestedAt: "desc" },
    take: 10,
    select: { id: true }
  });
  const keepIds = keepJobs.map(j => j.id);
  await prisma.scanJob.deleteMany({
    where: { id: { notIn: keepIds } }
  });

  const jobs = await prisma.scanJob.findMany({
    orderBy: { requestedAt: "desc" },
    take: 10,
  });

  const status = await prisma.systemStatus.findUnique({
    where: { key: "scanner_status" },
  });

  return NextResponse.json({ jobs, scannerStatus: status?.value ?? "idle" });
}

export async function DELETE(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");

  if (!id) {
    // Clear all finished jobs (COMPLETED, FAILED, CANCELLED)
    await prisma.scanJob.deleteMany({
      where: { status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
    });
    return NextResponse.json({ success: true });
  }

  const job = await prisma.scanJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (job.status === "RUNNING" || job.status === "PENDING") {
    await prisma.scanJob.update({ where: { id }, data: { status: "CANCELLED" } });
  } else {
    await prisma.scanJob.delete({ where: { id } });
  }

  return NextResponse.json({ success: true });
}
