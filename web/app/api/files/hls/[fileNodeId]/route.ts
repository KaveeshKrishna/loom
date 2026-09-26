/**
 * GET /api/files/hls/[fileNodeId] — how should the browser play this video?
 * { compatible: true }  -> play /api/files/serve directly
 * { compatible: false, durationSeconds } -> use the HLS manifest route
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route } from "@/lib/http";
import { isBrowserNative } from "@/lib/video-compat";
import { getOrProbeDuration } from "@/lib/hls-manager";
import { loadVideoNode } from "@/lib/video-node";

export const GET = route<{ params: Promise<{ fileNodeId: string }> }>(async (_req, { params }) => {
  const { fileNodeId } = await params;
  const { node, abs, contentIdentityId } = await loadVideoNode(fileNodeId);

  const { compatible } = await isBrowserNative(node.mimeType, abs, node.browserCompatible);
  if (node.browserCompatible === null) {
    await prisma.fileNode.update({ where: { id: node.id }, data: { browserCompatible: compatible } }).catch(() => {});
  }
  if (compatible) {
    return NextResponse.json({ compatible: true, fileNodeId, durationSeconds: null, hlsReady: false });
  }
  const durationSeconds = await getOrProbeDuration(contentIdentityId, abs);
  return NextResponse.json({ compatible: false, fileNodeId, durationSeconds, hlsReady: false });
});
