/**
 * GET /api/files/hls/[fileNodeId]/manifest.m3u8
 * GET /api/files/hls/[fileNodeId]/init.mp4
 * GET /api/files/hls/[fileNodeId]/segment_NNN.m4s
 *
 * Segments are generated on demand (see lib/hls-manager.ts). A segment that
 * isn't ready within the wait window returns 503 + Retry-After; hls.js retries.
 */
import { NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { route, badRequest } from "@/lib/http";
import { loadVideoNode } from "@/lib/video-node";
import {
  synthesizeManifest,
  ensureGeneration,
  waitForFile,
  recordActivity,
  getOrProbeDuration,
  touchVideoCache,
  getInitSegmentPath,
  getSegmentPath,
} from "@/lib/hls-manager";

const retryLater = () => new NextResponse(null, { status: 503, headers: { "Retry-After": "2" } });

export const GET = route<{ params: Promise<{ fileNodeId: string; segments: string[] }> }>(async (_req, { params }) => {
  const { fileNodeId, segments } = await params;
  const filename = segments.join("/");
  if (!/^(manifest\.m3u8|init\.mp4|segment_\d{3,6}\.m4s)$/.test(filename)) throw badRequest("Invalid HLS resource");

  const { abs, contentIdentityId: ci } = await loadVideoNode(fileNodeId);

  if (filename === "manifest.m3u8") {
    const duration = await getOrProbeDuration(ci, abs);
    if (!duration) return NextResponse.json({ error: "Could not read this video's duration" }, { status: 422 });
    await touchVideoCache(ci);
    return new NextResponse(synthesizeManifest(duration), {
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
    });
  }

  if (filename === "init.mp4") {
    const initPath = getInitSegmentPath(ci);
    if (!(await stat(initPath).catch(() => null))) {
      if (!(await ensureGeneration(ci, 0, abs))) return retryLater();
      if (!(await waitForFile(initPath))) return retryLater();
    }
    return streamCacheFile(initPath, "video/mp4");
  }

  const index = parseInt(filename.slice(8, -4), 10);
  const segPath = getSegmentPath(ci, index);
  recordActivity(ci, index);
  if (!(await stat(segPath).catch(() => null))) {
    if (!(await ensureGeneration(ci, index, abs))) return retryLater();
    if (!(await waitForFile(segPath))) return retryLater();
  }
  return streamCacheFile(segPath, "video/iso.segment");
});

async function streamCacheFile(path: string, contentType: string) {
  const s = await stat(path);
  return new NextResponse(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(s.size),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
