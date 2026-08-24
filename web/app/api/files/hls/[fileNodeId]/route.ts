import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { checkAccess } from "@/lib/acl";
import { headers } from "next/headers";
import { join } from "path";
import { isBrowserNative } from "@/lib/video-compat";
import { getOrProbeDuration } from "@/lib/hls-manager";

const MEDIA_ROOT = process.env.MEDIA_ROOT ?? "/media";

/**
 * GET /api/files/hls/[fileNodeId]
 *
 * Probe endpoint — returns:
 *   { compatible, fileNodeId, sourceVersion, durationSeconds, hlsReady }
 *
 * - If native browser compatible: client uses /api/files/serve directly.
 * - If incompatible: client attaches hls.js pointing at the manifest route.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileNodeId: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { fileNodeId } = await params;

  const fileNode = await prisma.fileNode.findUnique({ where: { id: fileNodeId } });
  if (!fileNode) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const allowed = await checkAccess(user.id, user.role, fileNode.relativePath);
  if (!allowed) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  if (fileNode.type !== "FILE") {
    return NextResponse.json({ error: "Not a file" }, { status: 400 });
  }

  const absolutePath = join(MEDIA_ROOT, fileNode.relativePath);

  // Determine browser compatibility (use stored result if available)
  const compatResult = await isBrowserNative(
    fileNode.mimeType,
    absolutePath,
    fileNode.browserCompatible
  );

  // Persist browserCompatible if not yet stored
  if (fileNode.browserCompatible === null) {
    await prisma.fileNode.update({
      where: { id: fileNodeId },
      data: { browserCompatible: compatResult.compatible },
    }).catch(() => {});
  }

  if (compatResult.compatible) {
    return NextResponse.json({
      compatible: true,
      fileNodeId,
      sourceVersion: fileNode.sourceVersion,
      durationSeconds: null,
      hlsReady: false,
    });
  }

  // Incompatible — probe duration (cached in VideoCache table)
  const sourceVersion = fileNode.sourceVersion ?? `${fileNode.size?.toString()}-${fileNode.modifiedAt?.getTime() ?? 0}`;
  const durationSeconds = await getOrProbeDuration(fileNodeId, sourceVersion, absolutePath);

  return NextResponse.json({
    compatible: false,
    fileNodeId,
    sourceVersion,
    durationSeconds,
    hlsReady: false, // generation is demand-driven via the segment route
  });
}
