/** GET /api/files/size?path=... — total size of the files inside a folder. */
import { NextResponse } from "next/server";
import { route, requireUser, forbidden } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { normalizeRelPath } from "@/lib/fs-guard";
import { folderStats } from "@/lib/file-ops";

export const GET = route(async (req) => {
  const user = await requireUser();
  const path = normalizeRelPath(req.nextUrl.searchParams.get("path"));
  const acl = await getAcl(user);
  if (!acl.canTraverse(path)) throw forbidden();
  const stats = await folderStats(path);
  return NextResponse.json(
    { path, size: stats.size.toString(), files: stats.files, dirs: stats.dirs },
    { headers: { "Cache-Control": "private, max-age=30" } }
  );
});
