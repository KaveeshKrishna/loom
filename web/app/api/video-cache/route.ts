/**
 * GET    /api/video-cache — size of converted-video (HLS) cache (Owner only)
 * DELETE /api/video-cache — delete all converted video segments. They are
 *        regenerated on demand the next time a video is played.
 */
import { NextResponse } from "next/server";
import { join } from "path";
import { readdir, rm, stat } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { route, requireOwner } from "@/lib/http";
import { CACHE_ROOT } from "@/lib/cache-access";

const VIDEO_CACHE_DIR = join(CACHE_ROOT, "videos");

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

export const GET = route(async () => {
  await requireOwner();
  const [usedBytes, cachedVideos] = await Promise.all([dirSize(VIDEO_CACHE_DIR), prisma.videoCache.count()]);
  return NextResponse.json({ usedBytes, cachedVideos });
});

export const DELETE = route(async () => {
  const owner = await requireOwner();
  // Keep the rows (they hold probed durations); only the segments go.
  for (const d of await readdir(VIDEO_CACHE_DIR).catch(() => [] as string[])) {
    await rm(join(VIDEO_CACHE_DIR, d), { recursive: true, force: true }).catch(() => {});
  }
  await prisma.auditLog.create({ data: { userId: owner.id, action: "VIDEO_CACHE_CLEARED", details: {} } });
  return NextResponse.json({ success: true });
});
