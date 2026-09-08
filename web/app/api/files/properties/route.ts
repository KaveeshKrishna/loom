import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { checkAccess } from "@/lib/acl";
import type { Role } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const pathParam = req.nextUrl.searchParams.get("path");
    if (!pathParam) return NextResponse.json({ error: "Path is required" }, { status: 400 });

    const allowed = await checkAccess(session.user.id, (session.user as unknown as { role: Role }).role, pathParam);
    if (!allowed) return NextResponse.json({ error: "Access denied" }, { status: 403 });

    const node = await prisma.fileNode.findFirst({
      where: { relativePath: pathParam },
      include: {
        contentIdentity: {
          include: {
            videoCaches: true
          }
        }
      }
    });

    if (!node) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let childCount = 0;
    let totalSize = BigInt(0);

    if (node.type === "DIRECTORY") {
      const prefix = `${node.relativePath}/`;
      const children = await prisma.fileNode.aggregate({
        where: {
          relativePath: { startsWith: prefix },
          inTrash: false,
          type: "FILE", // only count files for size, or both for count.
        },
        _count: { id: true },
        _sum: { size: true }
      });
      childCount = children._count.id;
      totalSize = children._sum.size || BigInt(0);

      // Add direct subdirectories to the count
      const dirChildren = await prisma.fileNode.count({
        where: {
          relativePath: { startsWith: prefix },
          inTrash: false,
          type: "DIRECTORY",
        }
      });
      childCount += dirChildren;
    }

    return NextResponse.json({
      type: node.type,
      relativePath: node.relativePath,
      size: (node.type === "DIRECTORY" ? totalSize : (node.size ?? BigInt(0))).toString(),
      childCount: node.type === "DIRECTORY" ? childCount : undefined,
      modifiedAt: node.modifiedAt,
      healthStatus: node.healthStatus,
      healthError: node.healthError,
      fastHash: node.contentIdentity?.fastHash,
      videoDetails: node.contentIdentity?.videoCaches?.[0] ? {
        duration: node.contentIdentity.videoCaches[0].durationSeconds ?? 0
      } : null
    });
  } catch (err: unknown) {
    console.error("Properties API Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
