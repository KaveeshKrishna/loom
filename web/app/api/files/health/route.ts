/**
 * GET /api/files/health?status=CORRUPT|UNSUPPORTED — files the scanner could
 * not process. Owner only.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireOwner } from "@/lib/http";

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
