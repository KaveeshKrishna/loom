/**
 * POST /api/fs/copy  { sourcePaths: string[], destDir, action? }
 * Copies files and folders (recursively). Copies keep their modification
 * time and share thumbnails with the original.
 */
import { NextResponse } from "next/server";
import { route, requireUser, readJson, badRequest } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { copyItem, parseConflictAction } from "@/lib/file-ops";

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson<{ sourcePaths?: unknown; destDir?: string; action?: string }>(req);
  if (!Array.isArray(body.sourcePaths) || body.sourcePaths.length === 0 || body.destDir == null) {
    throw badRequest("sourcePaths and destDir are required");
  }
  const acl = await getAcl(user);
  const onConflict = parseConflictAction(body.action);
  const results = [];
  for (const src of body.sourcePaths.slice(0, 5000)) {
    results.push(await copyItem(user, acl, { srcRel: String(src), destDirRel: body.destDir, onConflict }));
  }
  return NextResponse.json({ results });
});
