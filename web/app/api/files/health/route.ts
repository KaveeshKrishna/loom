import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";


/**
 * GET /api/files/health
 *
 * Returns all FileNodes with healthStatus != HEALTHY, grouped by status.
 * Supports ?status=CORRUPT|UNSUPPORTED to filter.
 * Owner only.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get("status") as "CORRUPT" | "UNSUPPORTED" | null;

    const healthStatuses = ["CORRUPT", "UNSUPPORTED"];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = statusFilter
      ? { healthStatus: statusFilter, inTrash: false }
      : { healthStatus: { in: healthStatuses }, inTrash: false };

    const nodes = await prisma.fileNode.findMany({
      where,
      select: {
        id: true,
        name: true,
        relativePath: true,
        type: true,
        mimeType: true,
        size: true,
        modifiedAt: true,
        healthStatus: true,
        healthError: true,
        sourceVersion: true,
      },
      orderBy: [{ healthStatus: "asc" }, { name: "asc" }],
    });

    const corrupt = nodes.filter((n) => n.healthStatus === "CORRUPT");
    const unsupported = nodes.filter((n) => n.healthStatus === "UNSUPPORTED");

    return NextResponse.json({
      nodes: nodes.map((n) => ({ ...n, size: n.size?.toString() ?? null })),
      summary: {
        total: nodes.length,
        corrupt: corrupt.length,
        unsupported: unsupported.length,
      },
    });
  } catch (err: unknown) {
    console.error("[Health API] Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
