import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { join } from "path";
import { readdir, rm } from "fs/promises";

const CACHE_ROOT = process.env.CACHE_ROOT ?? "/cache";
const THUMB_DIR = join(CACHE_ROOT, "thumbnails");
const PREVIEW_DIR = join(CACHE_ROOT, "previews");

/**
 * GET /api/thumbnail-cache
 * Returns counts of thumbnails + previews. Owner only.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [thumbCount, previewCount] = await Promise.all([
    prisma.thumbnail.count(),
    prisma.preview.count(),
  ]);

  // Count physical files (thumbnails + previews + .failed sentinels)
  let physicalFiles = 0;
  for (const dir of [THUMB_DIR, PREVIEW_DIR]) {
    try {
      const files = await readdir(dir);
      physicalFiles += files.length;
    } catch { /* dir may not exist yet */ }
  }

  return NextResponse.json({ thumbCount, previewCount, physicalFiles });
}

/**
 * DELETE /api/thumbnail-cache
 * Wipes ALL thumbnail + preview data so the scanner can regenerate from scratch.
 *
 * What it does:
 *   1. Deletes all `thumbnails` and `previews` DB records (Cascade from FileNode is not needed)
 *   2. Deletes every file inside /cache/thumbnails/ and /cache/previews/ (incl. .failed sentinels)
 *   3. Resets `sourceVersion` to NULL on all FileNodes so the scanner treats every file as "new"
 *      and regenerates thumbnails/previews unconditionally.
 *
 * What it does NOT touch:
 *   - Original media files on the T7 drive
 *   - The file_nodes index (names, paths, sizes, etc.)
 *   - HLS video cache (/cache/videos/) — use the separate "Clear HLS Cache" button for that
 *   - User data (favorites, ACL rules, sessions)
 */
export async function DELETE() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // 1. Wipe DB records
  await prisma.thumbnail.deleteMany({});
  await prisma.preview.deleteMany({});

  // 2. Delete all physical cache files (thumbnails, previews, .failed sentinels)
  for (const dir of [THUMB_DIR, PREVIEW_DIR]) {
    try {
      const files = await readdir(dir);
      await Promise.all(files.map(f => rm(join(dir, f), { force: true }).catch(() => {})));
    } catch { /* dir may not exist */ }
  }

  // 3. Reset sourceVersion on all FileNodes → scanner will treat every file as new and
  //    regenerate thumbnails/previews on the next FULL_RESCAN.
  await prisma.fileNode.updateMany({ data: { sourceVersion: null } });

  return NextResponse.json({ success: true });
}
