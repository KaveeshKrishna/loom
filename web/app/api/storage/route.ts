/**
 * GET /api/storage — disk usage of the media drive and the cache, plus (for
 * the Owner) a breakdown of the library by type, the space in Trash and the
 * space held by unfinished uploads.
 */
import { NextResponse } from "next/server";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import { route, requireUser } from "@/lib/http";
import { MEDIA_ROOT } from "@/lib/path-security";
import { CACHE_ROOT } from "@/lib/cache-access";

async function disk(path: string) {
  try {
    const s = await fs.statfs(path);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { total, free, used: total - Number(s.bfree) * Number(s.bsize) };
  } catch {
    return null;
  }
}

export const GET = route(async () => {
  const user = await requireUser();
  const [media, cache] = await Promise.all([disk(MEDIA_ROOT), disk(CACHE_ROOT)]);
  let breakdown: Record<string, { bytes: string; files: number }> | undefined;
  let trashBytes: string | undefined;
  let unfinishedUploads: { count: number; bytes: string } | undefined;
  if (user.role === "OWNER") {
    const rows = await prisma.$queryRaw<{ cat: string; bytes: bigint; files: bigint }[]>`
      SELECT CASE
               WHEN "mimeType" LIKE 'image/%' THEN 'image'
               WHEN "mimeType" LIKE 'video/%' THEN 'video'
               WHEN "mimeType" LIKE 'audio/%' THEN 'audio'
               WHEN "mimeType" LIKE 'text/%' OR "mimeType" ~ '(pdf|msword|officedocument|opendocument|ms-excel|ms-powerpoint|rtf|epub)' THEN 'document'
               ELSE 'other'
             END AS cat,
             COALESCE(SUM("size"), 0)::bigint AS bytes, COUNT(*) AS files
      FROM "file_nodes" WHERE "type" = 'FILE' AND "inTrash" = false
      GROUP BY 1`;
    breakdown = Object.fromEntries(rows.map((r) => [r.cat, { bytes: r.bytes.toString(), files: Number(r.files) }]));
    const t = await prisma.fileNode.aggregate({ _sum: { size: true }, where: { inTrash: true, type: "FILE" } });
    trashBytes = (t._sum.size ?? BigInt(0)).toString();
    const u = await prisma.uploadSession.aggregate({ _sum: { received: true }, _count: { _all: true } });
    unfinishedUploads = { count: u._count._all, bytes: (u._sum.received ?? BigInt(0)).toString() };
  }
  return NextResponse.json({ media, cache, breakdown, trashBytes, unfinishedUploads }, { headers: { "Cache-Control": "private, max-age=60" } });
});
