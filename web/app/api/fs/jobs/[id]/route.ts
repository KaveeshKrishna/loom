/**
 * GET    /api/fs/jobs/:id — a background job's status and progress.
 * DELETE /api/fs/jobs/:id — cancel it (files already copied stay).
 * Only the user who started the job (or an Owner) can see or cancel it.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, notFound } from "@/lib/http";
import { cancelCopyJob } from "@/lib/copy-jobs";

type Ctx = { params: Promise<{ id: string }> };

async function ownJob(id: string) {
  const user = await requireUser();
  const job = await prisma.backgroundJob.findUnique({ where: { id } });
  if (!job || (job.userId !== user.id && user.role !== "OWNER")) throw notFound("Job not found");
  return job;
}

export const GET = route<Ctx>(async (_req, { params }) => {
  const job = await ownJob((await params).id);
  return NextResponse.json({ id: job.id, kind: job.type, status: job.status, progress: job.progress, error: job.error, payload: job.payload });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const job = await ownJob((await params).id);
  return NextResponse.json({ cancelled: cancelCopyJob(job.id) });
});
