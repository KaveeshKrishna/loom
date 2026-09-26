/**
 * GET  /api/files/health?status=CORRUPT|UNSUPPORTED — files the scanner could
 *      not process. Owner only.
 * POST /api/files/health {fileNodeIds} — check those files again: reset their
 *      health and queue them for processing (e.g. after replacing a broken
 *      file or updating Loom). Owner only.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireOwner, readJson, badRequest } from "@/lib/http";
import { queueProcessFile, notifyScanner } from "@/lib/jobs";

export const GET = route(async (req) => {
  await requireOwner();
  const status = req.nextUrl.searchParams.get("status");
  const where =
    status === "CORRUPT" || status === "UNSUPPORTED"
      ? { healthStatus: status as "CORRUPT" | "UNSUPPORTED", inTrash: false }
      : { healthStatus: { in: ["CORRUPT", "UNSUPPORTED"] as ("CORRUPT" | "UNSUPPORTED")[] }, inTrash: false };

  const [nodes, counts] = await Promise.all([
    prisma.fileNode.findMany({
      where,
      select: {
        id: true, name: true, relativePath: true, type: true, mimeType: true, size: true,
        modifiedAt: true, healthStatus: true, healthError: true, sourceVersion: true,
      },
      orderBy: [{ healthStatus: "asc" }, { name: "asc" }],
      take: 5000,
    }),
    prisma.fileNode.groupBy({
      by: ["healthStatus"],
      where: { healthStatus: { in: ["CORRUPT", "UNSUPPORTED"] }, inTrash: false },
      _count: { _all: true },
    }),
  ]);
  const count = (s: string) => counts.find((c) => c.healthStatus === s)?._count._all ?? 0;
  return NextResponse.json({
    nodes: nodes.map((n) => ({ ...n, size: n.size?.toString() ?? null })),
    summary: { total: count("CORRUPT") + count("UNSUPPORTED"), corrupt: count("CORRUPT"), unsupported: count("UNSUPPORTED") },
  });
});

export const POST = route(async (req) => {
  const owner = await requireOwner();
  const { fileNodeIds } = await readJson<{ fileNodeIds?: unknown }>(req);
  if (!Array.isArray(fileNodeIds) || fileNodeIds.length === 0 || fileNodeIds.length > 5000 || !fileNodeIds.every((id) => typeof id === "string")) {
    throw badRequest("fileNodeIds must be a non-empty list of ids");
  }
  const nodes = await prisma.fileNode.findMany({
    where: { id: { in: fileNodeIds as string[] }, type: "FILE", inTrash: false },
    select: { id: true, name: true, relativePath: true, sourceVersion: true },
  });
  let queued = 0;
  await prisma.$transaction(async (tx) => {
    for (const n of nodes) {
      // Only files the scanner can process get re-checked; others (e.g. an
      // unsupported format) keep their status rather than looking fixed.
      if (!(await queueProcessFile(n, owner.id, tx))) continue;
      await tx.fileNode.update({ where: { id: n.id }, data: { healthStatus: "HEALTHY", healthError: null } });
      queued++;
    }
  }, { timeout: 60_000 });
  await notifyScanner();
  return NextResponse.json({ queued });
});
