/**
 * GET    /api/thumbnail-cache — counts of thumbnails/previews (Owner only)
 * DELETE /api/thumbnail-cache — wipe all thumbnails + previews and queue a
 *        rescan that regenerates them. Original files are never touched.
 */
import { NextResponse } from "next/server";
import { join } from "path";
import { readdir, rm } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { route, requireOwner } from "@/lib/http";
import { CACHE_ROOT } from "@/lib/cache-access";
import { notifyScanner } from "@/lib/jobs";

const DIRS = [join(CACHE_ROOT, "thumbnails"), join(CACHE_ROOT, "previews")];

export const GET = route(async () => {
  await requireOwner();
  const [thumbCount, previewCount] = await Promise.all([prisma.thumbnail.count(), prisma.preview.count()]);
  let physicalFiles = 0;
  for (const dir of DIRS) physicalFiles += (await readdir(dir).catch(() => [])).length;
  return NextResponse.json({ thumbCount, previewCount, physicalFiles });
});

export const DELETE = route(async () => {
  const owner = await requireOwner();
  await prisma.$transaction([prisma.thumbnail.deleteMany({}), prisma.preview.deleteMany({})]);
  for (const dir of DIRS) {
    const files = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(files.map((f) => rm(join(dir, f), { force: true }).catch(() => {})));
  }
  // The rescan sees unchanged files with missing thumbnails and regenerates them.
  const pending = await prisma.scanJob.findFirst({ where: { type: "FULL_RESCAN", status: { in: ["PENDING", "RUNNING"] } } });
  if (!pending) await prisma.scanJob.create({ data: { type: "FULL_RESCAN", status: "PENDING", requestedBy: owner.id } });
  await prisma.auditLog.create({ data: { userId: owner.id, action: "THUMBNAIL_CACHE_CLEARED", details: {} } });
  await notifyScanner();
  return NextResponse.json({ success: true });
});
