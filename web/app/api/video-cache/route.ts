import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { join } from "path";
import { rm, readdir } from "fs/promises";

const CACHE_ROOT = process.env.CACHE_ROOT ?? "/cache";
const VIDEO_CACHE_DIR = join(CACHE_ROOT, "videos");
const VIDEO_CACHE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB

/**
 * GET /api/video-cache
 * Returns aggregate VideoCache stats for the Settings panel. Owner only.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const caches = await prisma.videoCache.findMany({
    select: { sizeBytes: true, fileNodeId: true },
  });

  const totalBytes = caches.reduce((sum, c) => sum + Number(c.sizeBytes), 0);
  const totalVideos = caches.length;

  return NextResponse.json({
    usedBytes: totalBytes,
    limitBytes: VIDEO_CACHE_LIMIT_BYTES,
    cachedVideos: totalVideos,
  });
}

/**
 * DELETE /api/video-cache
 * Clears all VideoCache NVMe data and DB records. Owner only.
 * Does NOT delete original T7 files. Does NOT touch active generation jobs.
 */
export async function DELETE() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Delete all VideoCache DB records (CASCADE is not needed — we're deleting via Prisma)
  await prisma.videoCache.deleteMany({});

  // Remove NVMe video cache directory contents
  try {
    const nodeDirs = await readdir(VIDEO_CACHE_DIR);
    for (const nodeId of nodeDirs) {
      await rm(join(VIDEO_CACHE_DIR, nodeId), { recursive: true, force: true }).catch(() => {});
    }
  } catch {}

  return NextResponse.json({ success: true });
}
