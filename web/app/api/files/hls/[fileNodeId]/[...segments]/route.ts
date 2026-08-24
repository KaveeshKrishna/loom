import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { checkAccess } from "@/lib/acl";
import { headers } from "next/headers";
import { join } from "path";
import { createReadStream } from "fs";
import { stat, access } from "fs/promises";
import { constants } from "fs";
import { Readable } from "stream";
import {
  synthesizeManifest,
  ensureGeneration,
  waitForSegment,
  recordActivity,
  getOrProbeDuration,
  touchVideoCache,
  getInitSegmentPath,
  getSegmentPath,
} from "@/lib/hls-manager";

const MEDIA_ROOT = process.env.MEDIA_ROOT ?? "/media";

/**
 * GET /api/files/hls/[fileNodeId]/manifest.m3u8
 * GET /api/files/hls/[fileNodeId]/init.mp4
 * GET /api/files/hls/[fileNodeId]/segment_NNN.m4s
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileNodeId: string; segments: string[] }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { fileNodeId, segments } = await params;
  const filename = segments.join("/");

  console.log(`[HLS-seg] → ${fileNodeId}/${filename}`);

  // Only allow known filenames — prevent traversal
  const validFilename = /^(manifest\.m3u8|init\.mp4|segment_\d{3,}\.m4s)$/.test(filename);
  if (!validFilename) {
    console.warn(`[HLS-seg] Invalid filename rejected: ${filename}`);
    return NextResponse.json({ error: "Invalid HLS resource" }, { status: 400 });
  }

  const fileNode = await prisma.fileNode.findUnique({ where: { id: fileNodeId } });
  if (!fileNode) {
    console.error(`[HLS-seg] FileNode not found: ${fileNodeId}`);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const allowed = await checkAccess(user.id, user.role, fileNode.relativePath);
  if (!allowed) {
    console.warn(`[HLS-seg] Access denied for ${user.id} → ${fileNode.relativePath}`);
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Resolve sourceVersion — use stored or compute from size/mtime
  // NOTE: fileNode.size is BigInt; must call .toString() to avoid "37128553n" serialization
  const sourceVersion =
    fileNode.sourceVersion ??
    `${fileNode.size?.toString()}-${fileNode.modifiedAt?.getTime() ?? 0}`;

  const absoluteSource = join(MEDIA_ROOT, fileNode.relativePath);

  console.log(`[HLS-seg] sourceVersion=${sourceVersion} path=${absoluteSource}`);

  // Update activity lease for this file so FFmpeg doesn't get killed mid-serve
  recordActivity(fileNodeId, sourceVersion);
  await touchVideoCache(fileNodeId, sourceVersion).catch((err) =>
    console.error(`[HLS-seg] touchVideoCache error:`, err)
  );

  // ── manifest.m3u8 ──────────────────────────────────────────────────────────
  if (filename === "manifest.m3u8") {
    console.log(`[HLS-seg] Serving manifest, probing duration…`);
    const durationSeconds = await getOrProbeDuration(fileNodeId, sourceVersion, absoluteSource);
    if (!durationSeconds) {
      console.error(`[HLS-seg] Could not determine duration for ${fileNodeId}`);
      return NextResponse.json({ error: "Could not determine video duration" }, { status: 500 });
    }
    console.log(`[HLS-seg] Duration: ${durationSeconds}s — synthesizing manifest`);
    const manifest = synthesizeManifest(fileNodeId, sourceVersion, durationSeconds);
    return new NextResponse(manifest, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
        "X-Source-Duration": String(durationSeconds),
      },
    });
  }

  // ── init.mp4 ──────────────────────────────────────────────────────────────
  if (filename === "init.mp4") {
    const initPath = getInitSegmentPath(fileNodeId, sourceVersion);
    console.log(`[HLS-seg] init.mp4 path: ${initPath}`);

    // If init.mp4 doesn't exist yet, trigger generation of segment 0 so init.mp4 is created
    const initExists = await access(initPath, constants.R_OK).then(() => true).catch(() => false);
    console.log(`[HLS-seg] init.mp4 exists=${initExists}`);
    if (!initExists) {
      const durationSeconds = await getOrProbeDuration(fileNodeId, sourceVersion, absoluteSource);
      console.log(`[HLS-seg] init.mp4 missing — duration=${durationSeconds}, triggering ensureGeneration(seg=0)`);
      if (!durationSeconds) return NextResponse.json({ error: "Duration unavailable" }, { status: 503 });
      try {
        await ensureGeneration(fileNodeId, sourceVersion, 0, absoluteSource, durationSeconds);
        console.log(`[HLS-seg] ensureGeneration(0) returned — waiting for init.mp4`);
      } catch (err) {
        console.error(`[HLS-seg] ensureGeneration threw:`, err);
        return NextResponse.json({ error: "HLS generation failed" }, { status: 500 });
      }
      // Wait for segment 0 to appear. FFmpeg always writes init.mp4 completely BEFORE it finalizes segment_000.m4s.
      // By waiting for segment 0, we guarantee init.mp4 is 100% complete and flushed to disk.
      const ready = await waitForSegment(fileNodeId, sourceVersion, 0);
      if (!ready) {
        console.warn(`[HLS-seg] init.mp4 still missing (segment 0 timeout) after 30s — returning 503`);
        return new NextResponse(null, {
          status: 503,
          headers: { "Retry-After": "2" },
        });
      }
      console.log(`[HLS-seg] init.mp4 is ready`);
    }

    console.log(`[HLS-seg] Streaming init.mp4`);
    return streamFile(initPath, "video/mp4");
  }

  // ── segment_NNN.m4s ────────────────────────────────────────────────────────
  const segMatch = filename.match(/^segment_(\d+)\.m4s$/);
  if (!segMatch) {
    return NextResponse.json({ error: "Invalid segment" }, { status: 400 });
  }
  const segmentIndex = parseInt(segMatch[1], 10);
  const segmentPath = getSegmentPath(fileNodeId, sourceVersion, segmentIndex);
  console.log(`[HLS-seg] segment ${segmentIndex} path: ${segmentPath}`);

  // Fast path: segment already on disk
  const segExists = await access(segmentPath, constants.R_OK).then(() => true).catch(() => false);
  if (segExists) {
    console.log(`[HLS-seg] segment ${segmentIndex} already cached — streaming`);
    return streamFile(segmentPath, "video/iso.segment");
  }

  // Segment not on disk — trigger region-based generation
  const durationSeconds = await getOrProbeDuration(fileNodeId, sourceVersion, absoluteSource);
  if (!durationSeconds) {
    console.error(`[HLS-seg] Duration unavailable for segment ${segmentIndex}`);
    return new NextResponse(null, { status: 503, headers: { "Retry-After": "2" } });
  }
  console.log(`[HLS-seg] Triggering ensureGeneration for segment ${segmentIndex}`);

  try {
    await ensureGeneration(fileNodeId, sourceVersion, segmentIndex, absoluteSource, durationSeconds);
    console.log(`[HLS-seg] ensureGeneration(${segmentIndex}) returned`);
  } catch (err) {
    console.error(`[HLS-seg] ensureGeneration(${segmentIndex}) threw:`, err);
    return NextResponse.json({ error: "HLS generation failed" }, { status: 500 });
  }

  // Bounded wait for the segment to appear
  const ready = await waitForSegment(fileNodeId, sourceVersion, segmentIndex);
  if (!ready) {
    // Segment not ready within timeout — tell player to retry
    console.warn(`[HLS-seg] waitForSegment(${segmentIndex}) timed out — returning 503`);
    return new NextResponse(null, {
      status: 503,
      headers: { "Retry-After": "2" },
    });
  }

  console.log(`[HLS-seg] Streaming segment ${segmentIndex}`);
  return streamFile(segmentPath, "video/iso.segment");
}

// ---------------------------------------------------------------------------
// Stream a file from the NVMe cache to the client
// ---------------------------------------------------------------------------
async function streamFile(absolutePath: string, contentType: string): Promise<NextResponse> {
  try {
    const fileStat = await stat(absolutePath);
    const stream = createReadStream(absolutePath);
    const nodeReadable = Readable.toWeb(stream) as ReadableStream;
    return new NextResponse(nodeReadable, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileStat.size),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Accept-Ranges": "bytes",
      },
    });
  } catch (err) {
    console.error(`[HLS] streamFile failed for ${absolutePath}:`, err);
    return NextResponse.json({ error: "Cache file unavailable" }, { status: 500 });
  }
}
