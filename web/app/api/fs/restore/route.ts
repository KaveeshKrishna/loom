/**
 * POST /api/fs/restore  { fileNodeIds: string[], destDir?, action? }
 *
 * Restores items from Trash to where they were deleted from (or to destDir).
 * If something already exists there, the default ("ask") stops with a
 * conflict result; "keep_both" restores under a free name and "replace"
 * moves the current item to Trash first. Family users can only restore
 * items they deleted.
 */
import { NextResponse } from "next/server";
import { route, requireUser, readJson, badRequest } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { restoreItem, parseConflictAction } from "@/lib/file-ops";

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson<{ fileNodeIds?: unknown; destDir?: string | null; action?: string }>(req);
  if (!Array.isArray(body.fileNodeIds) || body.fileNodeIds.length === 0) {
    throw badRequest("No fileNodeIds provided");
  }
  const acl = await getAcl(user);
  const onConflict = parseConflictAction(body.action);
  const results = [];
  for (const id of body.fileNodeIds.slice(0, 5000)) {
    const r = await restoreItem(user, acl, { fileNodeId: String(id), destDirRel: body.destDir, onConflict });
    results.push(r.status === "conflict" ? { ...r, code: 409 } : r);
  }
  return NextResponse.json({ results });
});
